/**
 * Native Config
 */

import type { ChainConfig } from './chains';

export interface NativeConfig {
  // Default network for Native operations
  defaultNetwork?: number;
  // Custom chains to register
  chains?: ChainConfig[];
  // Custom RPC URLs for existing chains
  customRpcUrls?: Record<number, string>;
}
