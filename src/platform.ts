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

export class InverterSolarChargePlatform implements DynamicPlatformPlugin {
  // Cast the imported constructor to an unknown constructable object that outputs our interface.
  // This satisfies both the compiler and the strict 'no-explicit-any' ESLint rule.
  private readonly modbusClient =
    new (ModbusRTU as unknown as new () => CustomModbusClient)();

  private readonly plantId!: string;
  private readonly serialNum!: string;
  private readonly serialPort!: string;
  private readonly brand!: string; // Inverter brand (e.g., 'Growatt')
  private readonly inverterType!: string; // Inverter type (e.g., 'SPH3600')
  private readonly pollInterval: number = 5000; // Fixed polling: 5 seconds (hardcoded)
  private readonly uploadInterval!: number; // Aggregated upload interval (1-60 minutes)

  private pollingTimer?: NodeJS.Timeout;
  private uploadTimer?: NodeJS.Timeout;
  private dataBuffer!: DataBuffer;
  private accessories: PlatformAccessory[] = []; // Track all cached and created accessories
  private inverterAccessory?: PlatformAccessory;
  private batteryLevelAccessory?: PlatformAccessory;

  // HomeKit Services
  private lightSensorService?: Service;
  private batteryService?: Service;
  private switchService?: Service;
  private temperatureSensorService?: Service;
  private batterySwitchService?: Service;

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
    
    // Parse inverter string (format: "Brand Model", e.g., "Growatt SPH3600")
    const inverterString = config.inverter || 'Growatt SPH3600';
    const inverterParts = inverterString.split(' ');
    this.brand = inverterParts[0]; // e.g., "Growatt"
    this.inverterType = inverterParts.slice(1).join(' '); // e.g., "SPH3600" (supports multi-word models)
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
    
    const inverterUuid = this.api.hap.uuid.generate(`${this.brand}-${this.inverterType}-inverter-device`);
    const batteryLevelUuid = this.api.hap.uuid.generate(`${this.brand}-${this.inverterType}-battery-level`);
    // Legacy UUIDs for cleanup (from previous Growatt-specific implementation)
    const oldInverterUuid = this.api.hap.uuid.generate('growatt-sph-inverter-device-v2');
    const oldInverterUuidV1 = this.api.hap.uuid.generate('growatt-sph-inverter-device');
    const oldBatteryUuid = this.api.hap.uuid.generate('growatt-sph-battery-sensor');
    const oldSolarUuid = this.api.hap.uuid.generate('growatt-sph-solar-sensor');

    // Remove old legacy accessories from previous implementation
    if (
      accessory.UUID === oldInverterUuid ||
      accessory.UUID === oldInverterUuidV1 ||
      accessory.UUID === oldBatteryUuid ||
      accessory.UUID === oldSolarUuid
    ) {
      this.log.info(
        `Removing legacy accessory from cache: ${accessory.displayName}`,
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
      return;
    }

    // CRITICAL: Detect and REPAIR cached "Solar Battery" accessory
    // Old version has TemperatureSensor with "Battery %" name → causes HAP-NodeJS validation loop + CPU spike
    if (accessory.displayName === 'Solar Battery') {
      const expectedUuid = this.api.hap.uuid.generate(`${this.brand}-${this.inverterType}-battery-level`);
      
      // First: Check if TemperatureSensor has the old "Battery %" name and REMOVE it
      const tempSensor = accessory.getService(this.api.hap.Service.TemperatureSensor);
      if (tempSensor) {
        const nameChar = tempSensor.getCharacteristic(this.api.hap.Characteristic.Name);
        if (nameChar && (nameChar.value === 'Battery %' || String(nameChar.value).includes('Battery %'))) {
          this.log.error('🚨 CRITICAL: Found cached TemperatureSensor with INVALID "Battery %" name!');
          this.log.error('   This causes HAP-NodeJS validation loop and 90% CPU spike.');
          this.log.error('   Removing the broken service and will recreate with "Battery Level" name...');
          // Remove the broken service
          accessory.removeService(tempSensor);
        }
      }

      // Second: If this is our expected UUID, keep the accessory and let discoverDevices() fix it
      if (accessory.UUID === expectedUuid) {
        this.log.info('✓ Solar Battery accessory UUID is correct. Services will be repaired in discoverDevices()...');
      } else {
        // UUID doesn't match our current config - it's from old hardcoded Growatt-SPH version
        this.log.error('🚨 CRITICAL: Solar Battery has OLD hardcoded Growatt-SPH UUID!');
        this.log.error(`   UUID: ${accessory.UUID} | Expected: ${expectedUuid}`);
        this.log.error('   Unregistering and will recreate with dynamic UUID...');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        return; // Don't cache the old UUID version
      }
    }

    this.accessories.push(accessory);

    if (accessory.UUID === inverterUuid) {
      this.inverterAccessory = accessory;
    } else if (accessory.UUID === batteryLevelUuid) {
      this.batteryLevelAccessory = accessory;
    }
  }

  // Discovers or creates two separate HomeKit accessories with hierarchy:
  //
  // 📱 HOMEBRIDGE INVERTER SOLARCHARGE PLUGIN
  // ├─ 🔌 ACCESSORY 1: "Solar Inverter"
  // │  ├─ 💡 LightSensor → "Inverter Production" (Lux on Home screen)
  // │  ├─ 🔘 Switch → "Inverter Connected" (toggle on Home screen)
  // │  └─ 🔋 Battery → "Inverter Battery" (secondary - details only)
  // │
  // └─ 🔌 ACCESSORY 2: "Solar Battery"
  //    ├─ 🔘 Switch → "Battery Status" (big tile on Home screen - on if healthy ≥10%, off if low)
  //    └─ 🌡️ TemperatureSensor → "Battery Level" (secondary - shows % in details)

  private discoverDevices(): void {
    const inverterUuid = this.api.hap.uuid.generate(`${this.brand}-${this.inverterType}-inverter-device`);
    const batteryLevelUuid = this.api.hap.uuid.generate(`${this.brand}-${this.inverterType}-battery-level`);

    // ⚡ CRITICAL FIX: Detect and remove any cached accessories with invalid service names
    // This prevents HAP-NodeJS validation errors and CPU spikes from "Battery %" characteristic
    const accessoriesToRemove: PlatformAccessory[] = [];
    for (const accessory of this.accessories) {
      // Check for old Battery TemperatureSensor with invalid "Battery %" name
      const tempSensor = accessory.getService(this.api.hap.Service.TemperatureSensor);
      if (tempSensor) {
        // Get all characteristics to check the Name
        const nameChars = tempSensor.characteristics.filter(
          c => c.UUID === this.api.hap.Characteristic.Name.UUID
        );
        for (const nameChar of nameChars) {
          if (nameChar.value === 'Battery %' || String(nameChar.value).includes('Battery %')) {
            this.log.warn('🚨 CRITICAL FIX: Found cached accessory with INVALID "Battery %" name!');
            this.log.warn(`   Accessory: ${accessory.displayName} | Service: ${tempSensor.displayName}`);
            this.log.warn('   This causes HAP-NodeJS validation errors and 90% CPU spike.');
            this.log.warn('   ➤ Unregistering and will recreate with valid "Battery Level" name...');
            accessoriesToRemove.push(accessory);
            break;
          }
        }
      }
    }

    // Remove all broken accessories
    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
      // Remove from our tracking array too
      for (const broken of accessoriesToRemove) {
        const idx = this.accessories.indexOf(broken);
        if (idx >= 0) {
          this.accessories.splice(idx, 1);
        }
      }
      this.log.warn(`✅ Removed ${accessoriesToRemove.length} broken accessory(ies). Recreating now...`);
    }

    // --- INVERTER ACCESSORY (LightSensor + Switch + Battery) ---
    let inverterAccessory = this.accessories.find(
      (acc: PlatformAccessory) => acc.UUID === inverterUuid,
    );

    if (!inverterAccessory) {
      this.log.info('Registering Solar Inverter accessory...');
      inverterAccessory = new this.api.platformAccessory(
        'Solar Inverter',
        inverterUuid,
      );

      // Set category to SENSOR (primary device type for HomeKit compatibility)
      inverterAccessory.category = this.api.hap.Categories.SENSOR;

      // Setup Accessory Information
      inverterAccessory
        .getService(this.api.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.brand)
        .setCharacteristic(this.api.hap.Characteristic.Model, this.inverterType);

      // Add services to the inverter accessory
      inverterAccessory.addService(
        this.api.hap.Service.LightSensor,
        'Inverter Production',
      );
      inverterAccessory.addService(this.api.hap.Service.Switch, 'Inverter Connected');
      inverterAccessory.addService(this.api.hap.Service.Battery, 'Inverter Battery');

      this.accessories.push(inverterAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        inverterAccessory,
      ]);
    }

    this.inverterAccessory = inverterAccessory;

    // Get the Light Sensor service (displays current solar production in Lux)
    this.lightSensorService =
      this.inverterAccessory.getService(this.api.hap.Service.LightSensor) ||
      this.inverterAccessory.addService(this.api.hap.Service.LightSensor);

    if (this.lightSensorService) {
      this.lightSensorService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Inverter Production')
        .setCharacteristic(
          this.api.hap.Characteristic.CurrentAmbientLightLevel,
          0.0001, // HomeKit minimum lux value
        );
    }

    // Get the Switch service (virtual control button for Home app tile)
    this.switchService =
      this.inverterAccessory.getService(this.api.hap.Service.Switch) ||
      this.inverterAccessory.addService(this.api.hap.Service.Switch);

    if (this.switchService) {
      this.switchService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Inverter Connected')
        .setCharacteristic(this.api.hap.Characteristic.On, true);
    }

    // Get the Battery service (displays battery SoC as secondary service)
    this.batteryService =
      this.inverterAccessory.getService(this.api.hap.Service.Battery) ||
      this.inverterAccessory.addService(this.api.hap.Service.Battery);

    if (this.batteryService) {
      this.batteryService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Inverter Battery')
        .setCharacteristic(this.api.hap.Characteristic.BatteryLevel, 50) // Initial default
        .setCharacteristic(
          this.api.hap.Characteristic.StatusLowBattery,
          this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
    }

    // --- SEPARATE SOLAR BATTERY ACCESSORY (Switch as primary + TemperatureSensor as secondary) ---
    let batteryLevelAccessory = this.accessories.find(
      (acc: PlatformAccessory) => acc.UUID === batteryLevelUuid,
    );

    if (!batteryLevelAccessory) {
      this.log.info('Registering Solar Battery accessory...');
      batteryLevelAccessory = new this.api.platformAccessory(
        'Solar Battery',
        batteryLevelUuid,
      );

      // Set category to SWITCH (creates a big tile on Home screen)
      batteryLevelAccessory.category = this.api.hap.Categories.SWITCH;

      // Setup Accessory Information
      batteryLevelAccessory
        .getService(this.api.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.brand)
        .setCharacteristic(this.api.hap.Characteristic.Model, this.inverterType);

      // Add Switch as PRIMARY service (shows as big tile on Home screen)
      batteryLevelAccessory.addService(
        this.api.hap.Service.Switch,
        'Battery Status',
      );

      // Add TemperatureSensor as SECONDARY service (shows battery level in details)
      batteryLevelAccessory.addService(
        this.api.hap.Service.TemperatureSensor,
        'Battery Level',
      );

      this.accessories.push(batteryLevelAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        batteryLevelAccessory,
      ]);
    }

    this.batteryLevelAccessory = batteryLevelAccessory;

    // CRITICAL: Ensure Switch service exists (may be missing from old cached version)
    // Get or CREATE switch service - never retrieve-only
    this.batterySwitchService = batteryLevelAccessory.getService(this.api.hap.Service.Switch);
    if (!this.batterySwitchService) {
      this.log.warn('⚠️  Switch service missing from cached Solar Battery accessory. Adding it now...');
      this.batterySwitchService = batteryLevelAccessory.addService(this.api.hap.Service.Switch);
    }

    if (this.batterySwitchService) {
      this.batterySwitchService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Battery Status')
        .setCharacteristic(this.api.hap.Characteristic.On, true); // On = battery healthy
    }

    // CRITICAL: Ensure TemperatureSensor exists with CORRECT "Battery Level" name
    // Remove any old "Battery %" characteristic first, then create fresh sensor
    let tempSensorService = batteryLevelAccessory.getService(this.api.hap.Service.TemperatureSensor);
    if (tempSensorService) {
      // Check if it still has the old "Battery %" name
      const nameChar = tempSensorService.getCharacteristic(this.api.hap.Characteristic.Name);
      if (nameChar && (nameChar.value === 'Battery %' || String(nameChar.value).includes('Battery %'))) {
        this.log.error('🚨 CRITICAL: Cached TemperatureSensor still has invalid "Battery %" name!');
        this.log.error('   Removing and recreating with valid "Battery Level" name...');
        batteryLevelAccessory.removeService(tempSensorService);
        tempSensorService = undefined;
      }
    }

    // If TemperatureSensor doesn't exist (was removed or never created), create it now
    if (!tempSensorService) {
      this.log.info('Creating fresh TemperatureSensor service for battery level display...');
      tempSensorService = batteryLevelAccessory.addService(
        this.api.hap.Service.TemperatureSensor,
        'Battery Level',
      );
    }

    this.temperatureSensorService = tempSensorService;
    if (this.temperatureSensorService) {
      this.temperatureSensorService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Battery Level')
        .setCharacteristic(this.api.hap.Characteristic.CurrentTemperature, 50); // Initial default (0-100 maps to battery %)
    }
  }

  private async connectAndStartPolling(): Promise<void> {
    // Make sure HomeKit UI elements are ready (discover or create Solar Inverter and Solar Battery accessories)
    this.discoverDevices();

    try {
      this.log.info(
        `Connecting to inverter via Modbus on: ${this.serialPort}...`,
      );
      
      // Set a 10-second timeout for the connection attempt
      const connectionPromise = this.modbusClient.connectRTUBuffered(this.serialPort, {
        baudRate: 9600,
      });
      
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Modbus connection timeout after 10 seconds')), 10000)
      );
      
      await Promise.race([connectionPromise, timeoutPromise]);
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
      // Retry connection after 30 seconds
      this.log.info('Retrying connection in 30 seconds...');
      setTimeout(() => this.connectAndStartPolling(), 30000);
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

      // Read specific register blocks from configured inverter
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

      if (this.switchService) {
        // Keep the switch always "On" to show inverter is running
        this.switchService.updateCharacteristic(
          this.api.hap.Characteristic.On,
          true,
        );
      }

      if (this.batterySwitchService) {
        // Update battery switch: on if healthy (>=10%), off if low
        this.batterySwitchService.updateCharacteristic(
          this.api.hap.Characteristic.On,
          batterySoc >= 10, // On when battery is healthy
        );
      }

      if (this.temperatureSensorService) {
        // Display battery level as temperature value (0-100 maps to battery %)
        this.temperatureSensorService.updateCharacteristic(
          this.api.hap.Characteristic.CurrentTemperature,
          batterySoc,
        );
      }


    } catch (error: any) {
      this.log.error(`Error during inverter polling: ${error.message}`);
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
