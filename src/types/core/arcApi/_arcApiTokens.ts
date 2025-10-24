/**
 * Arc API Tokens Types
 *
 * Defines the core request and response types for the tokens.
 */

// Core token information
export interface TokenInfo {
  readonly address: string;
  readonly chainId: number;
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
  readonly coinKey?: string;
  readonly logoURI?: string;
  readonly priceUSD?: string;
  readonly originTokenAddress?: string; // Agglayer specific
  readonly originTokenNetwork?: number | null; // Agglayer specific
}

// Simplified token reference for cost breakdowns
export interface TokenReference {
  readonly address: string;
  readonly chainId: number;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly logoURI?: string;
}
