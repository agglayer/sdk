/**
 * SDK Config
 */

export const SDK_MODES = {
  LXLY: 'LXLY',
  AGGLAYER_API: 'AGGLAYER_API',
} as const;

export type SDKMode = (typeof SDK_MODES)[keyof typeof SDK_MODES];

import type { CoreConfig } from './core';
import type { LxlyConfig } from './native';

export interface SDKConfig {
  mode: SDKMode[];
  core: CoreConfig;
  lxly: LxlyConfig;
}
