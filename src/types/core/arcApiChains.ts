/**
 * Arc API Chains Types
 *
 * Defines the core request and response types for the chains endpoint.
 */

import { TokenInfo } from './_arcApiTokens';

export interface IChain {
  key: string;
  chainType: 'EVM';
  name: string;
  chainId: number; // todo: get it changed from backend, right now it's id
  logoURI: string;
  blockExplorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  networkId?: number; // only applicable for "agglayer" chains
  bridgeAddress?: string; // only applicable for "agglayer" chains
  supportedRoutes: string[]; // "lifi", "agglayer";
  fromTokens?: TokenInfo[];
  toTokens?: TokenInfo[];
}

export type ChainsQueryParams = {
  readonly withSupportedTokens?: boolean;
  readonly chainIds?: readonly number[];
  readonly limit?: number;
  readonly offset?: number;
};

export type ChainsResponse = {
  readonly chains: IChain[];
};
