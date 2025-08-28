/**
 * Contract Types
 *
 * Types related to contract interactions and configurations
 */

export interface BaseContractConfig {
  rpcUrl: string;
  chainId: number;
}

export interface ERC20Config extends BaseContractConfig {
  tokenAddress: string;
}

export interface BridgeConfig extends BaseContractConfig {
  bridgeAddress: string;
}
