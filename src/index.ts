/**
 * AggLayer SDK - Main SDK
 *
 * Main SDK that orchestrates different submodules
 */

import { LxlyClient } from '@/lxly';
import type { SDKConfig } from '@/types';
import { CoreClient } from '@/core';
import { DEFAULT_NETWORK } from './constants';

// Re-export all types from centralized location
export type * from './types';

export class AggLayerSDK {
  private config: SDKConfig;
  public core: CoreClient;
  public lxly?: LxlyClient;

  constructor(config: SDKConfig) {
    this.config = config;

    // Initialize core module (always required)
    this.core = new CoreClient(config);

    // Initialize lxly submodule if enabled
    if (this.config.mode?.includes('LXLY')) {
      const lxlyConfig = {
        defaultNetwork: this.config.lxly?.defaultNetwork || DEFAULT_NETWORK,
        ...(this.config.lxly?.chains && { chains: this.config.lxly.chains }),
        ...(this.config.lxly?.customRpcUrls && {
          customRpcUrls: this.config.lxly.customRpcUrls,
        }),
      };

      this.lxly = new LxlyClient(lxlyConfig);
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
}
