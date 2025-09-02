/**
 * Arc API Chains Types
 *
 * Defines the core request and response types for the chains endpoint.
 */

import { ApiResponse } from './_arcApiBase';
import { TokenReference } from './_arcApiTokens';

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
  toTokens: Array<{
    [tokenAddress: string]: TokenReference[];
  }>;
}

// Query parameters for the chains endpoint
export type ChainsQueryParams = {
  readonly chainIds?: readonly number[];
  readonly limit?: number;
  readonly startAfter?: number;
};

// Response for the chains endpoint
export type ChainsResponse = ApiResponse<{
  readonly chains: IChain[];
  readonly nextStartAfter?: number;
}>;
