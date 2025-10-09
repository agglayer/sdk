/**
 * Arc API Token Metadata Types
 *
 * Defines the core request and response types for the token metadata endpoint.
 */

// Types are reused, for consistency
export type TokenMetadataRequestParam = {
  tokenAddress: string;
};

export type TokenMetadataResponse = {
  originTokenNetwork: number;
  originTokenAddress: string;
  wrappedTokenAddressV1: string;
  wrappedTokenAddressV2: string;
  name: string;
  symbol: string;
  decimals: number;
};
