/**
 * Native Config
 */

import type { ChainConfig } from './chains';

export interface LxlyConfig {
  // Default network for LXLY operations
  defaultNetwork?: number;
  // Custom chains to register
  chains?: ChainConfig[];
  // Custom RPC URLs for existing chains
  customRpcUrls?: Record<number, string>;
}
