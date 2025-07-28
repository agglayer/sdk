export interface SDKConfig {
  apiBaseUrl?: string;
  apiTimeout?: number;
  websocketBaseUrl?: string;
}

export interface AgglayerSDK {
  config: SDKConfig;
}
