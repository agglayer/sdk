import { SDKConfig } from './types';

export class AggLayerSDK {
  public config: SDKConfig;

  constructor(config: SDKConfig) {
    // Initialize AggLayer SDK defaults
    this.config = {
      apiBaseUrl: 'https://api.agglayer.com', // todo: change to actual url
      apiTimeout: 10000,
      websocketBaseUrl: 'wss://api.agglayer.com', // todo: change to actual url
    };

    // Override with user config
    this.config = { ...this.config, ...config };
  }
}
