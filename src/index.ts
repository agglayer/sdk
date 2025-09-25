/**
 * AggLayer SDK - Main SDK
 *
 * Main SDK that orchestrates different submodules
 */

import { NativeClient } from '@/native';
import { SDK_MODES, type SDKConfig } from '@/types';
import { CoreClient } from '@/core';
import { DEFAULT_NETWORK } from './constants';

// Re-export all types from centralized location
export type * from './types';

// Re-export constants and values
export { SDK_MODES } from './types';

// Re-export error classes
export { ApiError } from './core/utils/apiError';

export class AggLayerSDK {
  private config: SDKConfig;

  private core?: CoreClient;
  private native?: NativeClient;

  constructor(config: SDKConfig) {
    this.config = config;

    /**
     * by default only core is enabled
     * if mode is not provided, only core is enabled
     * if mode is provided, only the modules in the mode are enabled
     * if mode is provided and core is not in the mode, core is not enabled
     * if mode is provided and native is not in the mode, native is not enabled
     * if mode is provided and core and native are in the mode, both are enabled
     * if mode is provided and core and native are not in the mode, default to core only
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

    // Initialize native submodule if enabled
    if (this.config.mode?.includes(SDK_MODES.NATIVE)) {
      if (!this.config.native) {
        throw new Error('NATIVE config is required');
      }

      const nativeConfig = {
        defaultNetwork: this.config.native?.defaultNetwork || DEFAULT_NETWORK,
        ...(this.config.native?.chains && {
          chains: this.config.native.chains,
        }),
        ...(this.config.native?.customRpcUrls && {
          customRpcUrls: this.config.native.customRpcUrls,
        }),
      };

      this.native = new NativeClient(nativeConfig);
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
   * Get native submodule
   */
  getNative(): NativeClient {
    if (!this.native) {
      throw new Error(
        'NATIVE module not initialized. Add "native" to mode array.'
      );
    }
    return this.native;
  }
}
