/**
 * Arc API Unsigned Transaction Types
 *
 * Defines the core request and response types for the tokens.
 */

export interface UnsignedTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly gasLimit: string;
  readonly gasPrice?: string;
  readonly chainId: number;
  readonly from?: string;
}
