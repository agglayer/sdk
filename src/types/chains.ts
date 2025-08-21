/**
 * Chain Types
 *
 * Types related to blockchain chains and networks
 */

export interface ChainConfig {
  chainId: number;
  networkId: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorer?: {
    name: string;
    url: string;
  };
  bridgeAddress?: string;
  proofApiUrl?: string;
  isTestnet?: boolean;
  isLocal?: boolean;
}

export interface CustomChainConfig extends ChainConfig {
  isTestnet?: boolean;
  isLocal?: boolean;
}
