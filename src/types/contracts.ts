/**
 * Contract Types
 *
 * Types related to contract interactions and configurations
 */

import type { BaseContractConfig } from './common';

export interface ERC20Config extends BaseContractConfig {
  tokenAddress: string;
}

export interface BridgeConfig extends BaseContractConfig {
  bridgeAddress: string;
}
