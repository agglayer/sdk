import { SDKConfig, SDK_MODES } from '@/types';
import { Lxly } from './lxly';

export class AggLayerSDK {
  public config: SDKConfig;
  public lxly?: Lxly;

  constructor(config: SDKConfig) {
    // Initialize AggLayer SDK defaults
    this.config = {
      mode: [SDK_MODES.LXLY, SDK_MODES.AGGLAYER_API],
      agglayerApi: {
        apiBaseUrl: 'https://api.agglayer.com', // todo: change to actual url
        apiTimeout: 10000,
        websocketBaseUrl: 'wss://api.agglayer.com', // todo: change to actual url
      },
      lxly: {
        network: 'mainnet',
      },
    };

    // Override with user config
    this.config = {
      mode: config.mode && config.mode.length ? config.mode : this.config.mode,
      agglayerApi: {
        ...this.config.agglayerApi,
        ...config.agglayerApi,
      },
      lxly: {
        ...this.config.lxly,
        ...config.lxly,
      },
    };

    // Initialize components based on mode
    if (this.config.mode.includes(SDK_MODES.LXLY)) {
      this.lxly = new Lxly(this.config.lxly);
    }
  }
}
