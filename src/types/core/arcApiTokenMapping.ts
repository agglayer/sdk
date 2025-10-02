/**
 * Arc API Token Mapping Types
 *
 * Defines the request and response types for the token mapping endpoint.
 */

export type TokenMappingQueryParams = {
  tokenAddress: string;
};

export type TokenMappingResponse = Array<{
  originTokenNetwork: number;
  originTokenAddress: string;
  wrappedTokenNetwork: number;
  wrappedTokenAddress: string;
}>;
