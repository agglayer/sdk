/**
 * AggLayer SDK - Main SDK
 *
 * Main SDK that orchestrates different submodules
 */

import { LxlyClient } from './lxly';
import { chainRegistry } from './chains/registry';
import type { SDKConfig } from './types';

// Re-export all types from centralized location
export type * from './types';

export class AggLayerSDK {
  private config: SDKConfig;
  public lxly?: LxlyClient;

  constructor(config: SDKConfig) {
    this.config = config;

    // Register custom chains if provided
    if (this.config.lxly?.chains) {
      this.config.lxly.chains.forEach((chain) => {
        chainRegistry.registerChain(chain);
      });
    }

    // Add custom RPC URLs if provided
    if (this.config.lxly?.customRpcUrls) {
      Object.entries(this.config.lxly.customRpcUrls).forEach(
        ([chainId, rpcUrl]) => {
          chainRegistry.addCustomRpcUrl(Number(chainId), rpcUrl);
        }
      );
    }

    // Initialize lxly submodule if enabled
    // todo: change to mainnet configs before publishing
    if (this.config.mode?.includes('LXLY')) {
      this.lxly = new LxlyClient({
        defaultNetwork: this.config.lxly?.defaultNetwork || 11155111, // Default to Sepolia
      });
    }
  }

  /**
   * Get lxly submodule
   */
  getLxly(): LxlyClient {
    if (!this.lxly) {
      throw new Error('LXLY module not initialized. Add "lxly" to mode array.');
    }
    return this.lxly;
  }

  /**
   * Get chain registry for advanced usage
   */
  getChainRegistry() {
    return chainRegistry;
  }

  /**
   * Get supported chain IDs
   */
  getSupportedChainIds(): number[] {
    return chainRegistry.getSupportedChainIds();
  }

  /**
   * Check if chain is supported
   */
  isChainSupported(chainId: number): boolean {
    return chainRegistry.isChainSupported(chainId);
  }
}
