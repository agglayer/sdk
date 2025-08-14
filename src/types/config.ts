/**
 * SDK Config
 */

export const SDK_MODES = {
  LXLY: 'LXLY',
  AGGLAYER_API: 'AGGLAYER_API',
} as const;

export type SDKMode = (typeof SDK_MODES)[keyof typeof SDK_MODES];

export interface SDKConfig {
  mode: SDKMode[];
  agglayerApi: APIConfig;
  lxly: LxlyConfig;
}

export interface APIConfig {
  apiBaseUrl?: string;
  apiTimeout?: number;
  websocketBaseUrl?: string;
}

export interface LxlyConfig {
  // network to decide on proof api url
  network: 'mainnet' | 'testnet';
  providers?: Record<
    number,
    {
      rpcUrl: string;
      chainId: number;
      name?: string;
      isTestnet?: boolean;
    }
  >;
}
