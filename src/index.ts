/**
 * AggLayer SDK - Main SDK
 *
 * Main SDK that orchestrates different submodules
 */

import { LxlyClient } from '@/lxly';
import { SDK_MODES, type SDKConfig } from '@/types';
import { CoreClient } from '@/core';
import { DEFAULT_NETWORK } from './constants';

// Re-export all types from centralized location
export type * from './types';

export class AggLayerSDK {
  private config: SDKConfig;

  private core?: CoreClient;
  private lxly?: LxlyClient;

  constructor(config: SDKConfig) {
    this.config = config;

    /**
     * by default only core is enabled
     * if mode is not provided, only core is enabled
     * if mode is provided, only the modules in the mode are enabled
     * if mode is provided and core is not in the mode, core is not enabled
     * if mode is provided and lxly is not in the mode, lxly is not enabled
     * if mode is provided and core and lxly are in the mode, both are enabled
     * if mode is provided and core and lxly are not in the mode, default to core only
     */

    if (!config.mode || (config.mode && config.mode.length === 0)) {
      this.config.mode = ['CORE'];
    }

    if (config.mode.includes(SDK_MODES.CORE)) {
      if (!this.config.core) {
        throw new Error('Core config is required');
      }

      this.core = new CoreClient(this.config.core);
    }

    // Initialize lxly submodule if enabled
    if (this.config.mode?.includes(SDK_MODES.LXLY)) {
      if (!this.config.lxly) {
        throw new Error('LXLY config is required');
      }

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
   * Get core submodule
   */
  getCore(): CoreClient {
    if (!this.core) {
      throw new Error('Core module not initialized. Add "core" to mode array.');
    }
    return this.core;
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
