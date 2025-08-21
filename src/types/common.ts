/**
 * Common Types
 *
 * Shared type definitions used across the entire SDK
 */

export interface TransactionParams {
  from?: string | undefined;
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string | undefined;
}

export interface BaseContractConfig {
  rpcUrl: string;
  chainId: number;
}
