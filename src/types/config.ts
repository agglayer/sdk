/**
 * SDK Config
 */

export const SDK_MODES = {
  LXLY: 'LXLY',
  AGGLAYER_API: 'AGGLAYER_API',
} as const;

export type SDKMode = (typeof SDK_MODES)[keyof typeof SDK_MODES];

import type { APIConfig } from './api';

export interface SDKConfig {
  mode: SDKMode[];
  agglayerApi: APIConfig;
  lxly: LxlyConfig;
}

import type { ChainConfig } from './chains';

export interface LxlyConfig {
  // Default network for LXLY operations
  defaultNetwork?: number;
  // Custom chains to register
  chains?: ChainConfig[];
  // Custom RPC URLs for existing chains
  customRpcUrls?: Record<number, string>;
}
