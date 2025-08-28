/**
 * Transaction Types
 *
 * Types related to transaction operations
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
