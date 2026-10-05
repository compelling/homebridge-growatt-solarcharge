import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformConfig,
  PlatformAccessory,
  Service,
} from 'homebridge';
import ModbusRTU from 'modbus-serial';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// Define a local interface for the Modbus client methods we use.
// This bypasses the legacy CommonJS namespace mapping bugs in strict TypeScript environments.
interface CustomModbusClient {
  connectRTUBuffered(
    path: string,
    options: { baudRate: number },
  ): Promise<void>;
  setID(id: number): void;
  readInputRegisters(
    dataAddress: number,
    length: number,
  ): Promise<{ data: number[] }>;
}

/**
 * DataBuffer accumulates power metrics over a polling period for averaging.
 * Stores individual readings and calculates averages for aggregated uploads.
 */
interface PowerMetrics {
  solar: number; // kW
  export: number; // kW
  pack: number; // kW (grid import)
  usage: number; // kW (local load)
}

class DataBuffer {
  private solarSamples: number[] = [];
  private exportSamples: number[] = [];
  private packSamples: number[] = [];
  private usageSamples: number[] = [];

  add(metrics: PowerMetrics): void {
    this.solarSamples.push(metrics.solar);
    this.exportSamples.push(metrics.export);
    this.packSamples.push(metrics.pack);
    this.usageSamples.push(metrics.usage);
  }

  average(): PowerMetrics {
    if (this.solarSamples.length === 0) {
      return { solar: 0, export: 0, pack: 0, usage: 0 };
    }

    const avg = (samples: number[]): number => {
      const sum = samples.reduce((acc, val) => acc + val, 0);
      return parseFloat((sum / samples.length).toFixed(3));
    };

    return {
      solar: avg(this.solarSamples),
      export: avg(this.exportSamples),
      pack: avg(this.packSamples),
      usage: avg(this.usageSamples),
    };
  }

  sampleCount(): number {
    return this.solarSamples.length;
  }

  clear(): void {
    this.solarSamples = [];
    this.exportSamples = [];
    this.packSamples = [];
    this.usageSamples = [];
  }
}

export class GrowattSolarChargePlatform implements DynamicPlatformPlugin {
  // Cast the imported constructor to an unknown constructable object that outputs our interface.
  // This satisfies both the compiler and the strict 'no-explicit-any' ESLint rule.
  private readonly modbusClient =
    new (ModbusRTU as unknown as new () => CustomModbusClient)();

  private readonly plantId!: string;
  private readonly serialNum!: string;
  private readonly serialPort!: string;
  private readonly pollInterval: number = 5000; // Fixed polling: 5 seconds (hardcoded)
  private readonly uploadInterval!: number; // Aggregated upload interval (1-60 minutes)

  private pollingTimer?: NodeJS.Timeout;
  private uploadTimer?: NodeJS.Timeout;
  private dataBuffer!: DataBuffer;
  private accessory?: PlatformAccessory;

  // HomeKit Services
  private lightSensorService?: Service;
  private batteryService?: Service;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    if (!config || !config.plantId || !config.serialNum) {
      this.log.warn(
        'Plugin is not configured yet. Please enter your plantId and serialNum in the Homebridge UI.',
      );
      return;
    }

    this.plantId = config.plantId;
    this.serialNum = config.serialNum;
    this.serialPort = config.serialPort || '/dev/ttyUSB0';
    // Fixed polling interval: always 5 seconds for HomeKit responsiveness
    this.pollInterval = 5000;
    // Upload aggregation interval: configurable, default 300s (5 minutes)
    this.uploadInterval = Math.max(config.uploadInterval || 300, 60) * 1000;
    this.dataBuffer = new DataBuffer();

    this.api.on('didFinishLaunching', () => {
      this.connectAndStartPolling();
    });
  }

  // Homebridge calls this method when loading cached accessories from disk.

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessory = accessory;
  }

  // Initializes or updates the HomeKit accessory and its services

  private setupHomeKitAccessory(): void {
    const uuid = this.api.hap.uuid.generate('homebridge-growatt-sph-inverter');

    // If the accessory was not loaded from cache, create a new one
    if (!this.accessory) {
      this.log.info('Creating new Growatt Inverter accessory...');
      this.accessory = new this.api.platformAccessory('Growatt Inverter', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        this.accessory,
      ]);
    }

    // Setup Accessory Information
    this.accessory
      .getService(this.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'SPH3600');

    // Setup Light Sensor Service (Used to display current Watts as Lux)
    this.lightSensorService =
      this.accessory.getService(this.api.hap.Service.LightSensor) ||
      this.accessory.addService(this.api.hap.Service.LightSensor);

    this.lightSensorService
      .setCharacteristic(this.api.hap.Characteristic.Name, 'Current Production')
      .setCharacteristic(
        this.api.hap.Characteristic.CurrentAmbientLightLevel,
        0.0001, // HomeKit minimum lux value
      );

    // Setup Battery Service (Used to display Battery State of Charge %)
    this.batteryService =
      this.accessory.getService(this.api.hap.Service.Battery) ||
      this.accessory.addService(this.api.hap.Service.Battery);

    this.batteryService
      .setCharacteristic(this.api.hap.Characteristic.Name, 'Inverter Battery')
      .setCharacteristic(this.api.hap.Characteristic.BatteryLevel, 50) // Initial default
      .setCharacteristic(
        this.api.hap.Characteristic.StatusLowBattery,
        this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
  }

  private async connectAndStartPolling(): Promise<void> {
    // Make sure HomeKit UI elements are ready
    this.setupHomeKitAccessory();

    try {
      this.log.info(
        `Connecting to Growatt SPH via Modbus on: ${this.serialPort}...`,
      );
      await this.modbusClient.connectRTUBuffered(this.serialPort, {
        baudRate: 9600,
      });
      this.modbusClient.setID(1);

      this.log.info(
        'Modbus connection established successfully! Starting polling loops.',
      );

      // Initial poll and start the fixed polling timer (5 seconds)
      await this.pollInverterData();
      this.pollingTimer = setInterval(
        () => this.pollInverterData(),
        this.pollInterval,
      );

      // Start the upload aggregation timer (configurable interval)
      this.uploadTimer = setInterval(
        () => this.uploadAggregatedData(),
        this.uploadInterval,
      );

      this.log.info(
        `Fixed polling: every ${this.pollInterval}ms | Aggregated upload: every ${this.uploadInterval}ms`,
      );
    } catch (error: any) {
      this.log.error(
        `Failed to establish Modbus connection on ${this.serialPort}: ${error.message}`,
      );
    }
  }

  /**
   * Helper function to convert raw Growatt Modbus register value to kWatt (kW).
   * Growatt SPH handles values with a 0.1 multiplier for Watts. Dividing by 1000 converts to kW.
   * For u32 values spanning 2 registers: combine high word (first register) and low word (second).
   * Total conversion factor: (value * 0.1) / 1000 = value / 10000
   */
  private convertRegisterToKW(rawValue: number): number {
    const kW = rawValue / 10000;
    // Round to 3 decimal places (nearest Watt equivalent in kW, e.g., 1.234 kW)
    return parseFloat(kW.toFixed(3));
  }

  /**
   * Combine two 16-bit register values into a single 32-bit value (u32).
   * Modbus u32 values span 2 consecutive registers: high word first, then low word.
   */
  private combineU32(highWord: number, lowWord: number): number {
    return (highWord << 16) | lowWord;
  }

  private async pollInverterData(): Promise<void> {
    try {
      this.log.debug('Polling inverter for data...');

      // Read specific register blocks from Growatt SPH3600 (per ha-growatt-modbus)
      // Register 1-2: PV Power (u32) - addresses 1-2
      const pvResult = await this.modbusClient.readInputRegisters(1, 2);
      const pvRaw = pvResult?.data
        ? this.combineU32(pvResult.data[0] || 0, pvResult.data[1] || 0)
        : 0;
      const solarKW = this.convertRegisterToKW(pvRaw);

      // Register 1014: Battery SoC (u16)
      const batteryResult = await this.modbusClient.readInputRegisters(1014, 1);
      const batterySoc = Math.min(Math.max(batteryResult?.data?.[0] || 0, 0), 100);

      // Register 1021-1022: Grid Import Power (u32)
      const importResult = await this.modbusClient.readInputRegisters(1021, 2);
      const importRaw = importResult?.data
        ? this.combineU32(importResult.data[0] || 0, importResult.data[1] || 0)
        : 0;
      const packKW = this.convertRegisterToKW(importRaw);

      // Register 1029-1030: Grid Export Power (u32)
      const exportResult = await this.modbusClient.readInputRegisters(1029, 2);
      const exportRaw = exportResult?.data
        ? this.combineU32(exportResult.data[0] || 0, exportResult.data[1] || 0)
        : 0;
      const exportKW = this.convertRegisterToKW(exportRaw);

      // Register 1037-1038: Local Load Power (u32)
      const loadResult = await this.modbusClient.readInputRegisters(1037, 2);
      const loadRaw = loadResult?.data
        ? this.combineU32(loadResult.data[0] || 0, loadResult.data[1] || 0)
        : 0;
      const usageKW = this.convertRegisterToKW(loadRaw);

      // Add metrics to buffer for later aggregation
      this.dataBuffer.add({
        solar: solarKW,
        export: exportKW,
        pack: packKW,
        usage: usageKW,
      });

      this.log.info(
        `Inverter Data -> Solar: ${solarKW}kW | Export: ${exportKW}kW | Import: ${packKW}kW | Load: ${usageKW}kW | Battery: ${batterySoc}%`,
      );

      // Update Apple Home UI Elements with current (live) values
      const currentWatts = Math.max(pvRaw * 0.1, 0.0001); // HomeKit Lux minimum is 0.0001

      if (this.lightSensorService) {
        // Lux value maps 1:1 to current Watts
        this.lightSensorService.updateCharacteristic(
          this.api.hap.Characteristic.CurrentAmbientLightLevel,
          currentWatts,
        );
      }

      if (this.batteryService) {
        // Update BatteryLevel characteristic with the actual percentage
        this.batteryService.updateCharacteristic(
          this.api.hap.Characteristic.BatteryLevel,
          batterySoc,
        );

        // Update StatusLowBattery: only set to LOW if battery < 10%, otherwise NORMAL
        // This prevents the "Low battery voltage" warning from appearing unnecessarily
        const isLow =
          batterySoc < 10
            ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        this.batteryService.updateCharacteristic(
          this.api.hap.Characteristic.StatusLowBattery,
          isLow,
        );
      }
    } catch (error: any) {
      this.log.error(`Error during Growatt inverter polling: ${error.message}`);
    }
  }

  private async uploadAggregatedData(): Promise<void> {
    const sampleCount = this.dataBuffer.sampleCount();

    if (sampleCount === 0) {
      this.log.debug('No samples in buffer yet, skipping upload.');
      return;
    }

    const avgMetrics = this.dataBuffer.average();

    this.log.info(
      `Uploading aggregated data (${sampleCount} samples) to SolarCharge API: ` +
        `Solar=${avgMetrics.solar}kW, Export=${avgMetrics.export}kW, Import=${avgMetrics.pack}kW, Usage=${avgMetrics.usage}kW`,
    );

    try {
      // Calculate time window: from (now - uploadInterval) to now
      const now = new Date();
      const uploadStart = new Date(now.getTime() - this.uploadInterval);

      const startHHMM = uploadStart.toTimeString().slice(0, 5); // "HH:MM"
      const endHHMM = now.toTimeString().slice(0, 5); // "HH:MM"

      await this.uploadToSolarCharge(
        avgMetrics.solar,
        avgMetrics.export,
        avgMetrics.pack,
        avgMetrics.usage,
        startHHMM,
        endHHMM,
      );

      // Clear buffer after successful upload
      this.dataBuffer.clear();
    } catch (error: any) {
      this.log.error(
        `Error during aggregated upload: ${error.message}`,
      );
    }
  }

  private async uploadToSolarCharge(
    solarKW: number,
    exportKW: number,
    packKW: number,
    usageKW: number,
    startTime: string,
    endTime: string,
  ): Promise<void> {
    try {
      const response = await fetch(
        'https://groshapp.com/test/inverterdata', // test server
        // 'https://gr1.compellingsoftware.com/edge/inverterdata', // production server
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            plantId: this.plantId,
            serialNum: this.serialNum,
            branding: 'sc',
            start: startTime, // e.g., "14:05"
            end: endTime, // e.g., "14:10"
            solar: solarKW, // Averaged kW (ppv - produced solar power)
            usage: usageKW, // Averaged kW (local load consumption)
            export: exportKW, // Averaged kW (export to grid)
            pack: packKW, // Averaged kW (grid import / battery charge)
          }),
        },
      );

      if (!response.ok) {
        this.log.error(
          `SolarCharge API error: ${response.status} ${response.statusText}`,
        );
      } else {
        this.log.debug('Successfully uploaded aggregated data to SolarCharge API');
      }
    } catch (error: any) {
      this.log.error(
        `Could not upload data to SolarCharge API: ${error.message}`,
      );
    }
  }
}
