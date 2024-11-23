import { Service, API, AccessoryConfig, Logging, AccessoryPlugin, Controller,
  ControllerServiceMap, CharacteristicValue, Characteristic} from 'homebridge';

import { Connection, DeviceState, OperationMode, PowerMode } from 'samsung-cac';

import forge from 'node-forge';
import * as net from 'net';
import { Duplex } from 'stream';

class NodeTLSSocket extends Duplex {

  private socket: net.Socket;
  private client: forge.tls.Connection;

  public constructor(host: string, port: number) {
    super();

    this.socket = new net.Socket();

    this.client = forge.tls.createConnection({
      server: false,

      verify: () => {
        return true;
      },

      connected: () => {
        this.emit('open');
      },

      tlsDataReady: (conn: forge.tls.Connection) => {
        const data = conn.tlsData.getBytes();
        this.socket.write(data, 'binary');
      },

      dataReady: (conn: forge.tls.Connection) => {
        const data = conn.data.getBytes();
        this.emit('data', data);
      },

      closed: () => {
        this.emit('close');
      },

      error: (conn: forge.tls.Connection, error: forge.tls.TLSError) => {
        this.emit('error', error);
      },
    });

    this.socket.on('data', (bytes) => {
      this.client.process(bytes.toString('binary'));
    });

    this.socket.connect({host, port}, () => {
      this.client.handshake();
    });

  }

  write(chunk: string | Uint8Array | Buffer): boolean {
    this.client.prepare(chunk.toString('binary'));

    return true;
  }
}

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
// export const PLATFORM_NAME = 'SamsungCacModern';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-samsung-cac-modern';

// Samsung CAC Thermostat Plugin

export class SamsungCacThermostatAccessory implements AccessoryPlugin {
  log: Logging;
  config: AccessoryConfig;
  api: API;
  name: string;
  service: Service;

  cac? : Connection;
  deviceUid?: string;
  currentState?: DeviceState;

  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  constructor(logger: Logging, config: AccessoryConfig, api: API) {
    this.log = logger;
    this.config = config;
    this.api = api;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    // extract name from config
    this.name = config.name;

    // create a new Thermostat service
    this.service = new this.Service.Thermostat(this.name);

    // create handlers for required characteristics
    this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this));

  }

  identify?(): void {
    this.log.debug('identify called');
  }

  getServices(): Service[] {
    return [this.service];
  }

  getControllers?(): Controller<ControllerServiceMap>[] {
    return [];
  }

  private getCac(): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      if(!this.cac) {
        this.log.info('Connecting to %o', this.config.host);

        const cxn = new Connection(this.config.host);
        cxn.debug_log = (v) => {
          this.log.debug(v);
        };

        cxn.connect((host: string, port: number) => {
          return new NodeTLSSocket(host, port);
        }).then(c => {
          this.log.info('Connected to %o', this.config.host);
          this.cac = c;

          c.Disconnected.on(() => {
            this.log.info('Disconnected from %o', this.config.host);
            this.cac = undefined;
          });


          c.Error.on(() => {
            this.log.info('Error - disconnecting from %o', this.config.host);
            this.cac = undefined;
          });

          this.log.info('Logging in to %o', this.config.host);
          c.login(this.config.token).then(() => {
            c.deviceList().then(devs => {
              if(devs.length > 0) {
                this.deviceUid = devs[0].duid;
                resolve(this.cac!);
              } else {
                reject('No device found');
              }
            });
          });
        }).catch(reject);
      } else {
        resolve(this.cac);
      }
    });
  }


  private getDeviceState(): Promise<DeviceState> {
    return this.getCac().then(c => {
      return c.deviceState(this.deviceUid!).then(dev => {
        // ensure that the device will be repolled every now an again
        setTimeout(() => {
          this.currentState = undefined;
          this.currentPromise = undefined;
        }, 10000);

        return dev.state;
      });
    });
  }

  private currentPromise?: Promise<DeviceState>;

  private currentDeviceState(): Promise<DeviceState> {
    if(!this.currentPromise) {
      this.currentPromise = new Promise<DeviceState>((resolve, reject) => {
        if(this.currentState) {
          resolve(this.currentState);
        }

        this.getDeviceState().then(resolve).catch(reject);
      });
    }
    return this.currentPromise;
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  handleCurrentHeatingCoolingStateGet() {
    return this.currentDeviceState().then(state => {
      if(state.power === PowerMode.Off) {
        return this.Characteristic.CurrentHeatingCoolingState.OFF;
      }

      switch(state.operation) {
        case OperationMode.Cool:
          return this.Characteristic.CurrentHeatingCoolingState.COOL;

        case OperationMode.Heat:
          return this.Characteristic.CurrentHeatingCoolingState.HEAT;

      }

      return this.Characteristic.CurrentHeatingCoolingState.OFF;
    });
  }


  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet() {
    return this.currentDeviceState().then(state => {
      if(state.power === PowerMode.Off) {
        return this.Characteristic.TargetHeatingCoolingState.OFF;
      }

      switch(state.operation) {
        case OperationMode.Cool:
          return this.Characteristic.TargetHeatingCoolingState.COOL;

        case OperationMode.Heat:
          return this.Characteristic.TargetHeatingCoolingState.HEAT;

        case OperationMode.Auto:
          return this.Characteristic.TargetHeatingCoolingState.AUTO;
      }

      return this.Characteristic.TargetHeatingCoolingState.OFF;
    });
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.getCac().then(c => {
      switch(value) {
        case this.Characteristic.TargetHeatingCoolingState.OFF:
          c.controlDevice(this.deviceUid!, { power: PowerMode.Off });
          break;

        case this.Characteristic.TargetHeaterCoolerState.COOL:
          c.controlDevice(this.deviceUid!, { power: PowerMode.On, op: OperationMode.Cool });
          break;

        case this.Characteristic.TargetHeaterCoolerState.HEAT:
          c.controlDevice(this.deviceUid!, { power: PowerMode.On, op: OperationMode.Heat });
          break;

        case this.Characteristic.TargetHeaterCoolerState.AUTO:
          c.controlDevice(this.deviceUid!, { power: PowerMode.On, op: OperationMode.Auto });
          break;
      }
    });
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    return this.currentDeviceState().then(state => {
      return state.current_temp!;
    });
  }


  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet() {
    return this.currentDeviceState().then(state => {
      return state.target_temp!;
    });
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(value: CharacteristicValue) {
    this.getCac().then(c => {
      c.controlDevice(this.deviceUid!, {target_temp: value as number});
    });
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet() {
    return this.api.hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

}

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  api.registerAccessory(PLUGIN_NAME, 'SamsungCacModern', SamsungCacThermostatAccessory);
};
