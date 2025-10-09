/**
 * Arc API Build Claim Transaction Types
 *
 * Defines the core request and response types for the build claim transaction endpoint.
 */

import { UnsignedTransaction } from './_arcApiUnsignedTransaction';

// Types are reused, for consistency
export type BuildClaimTransactionRequestParam = {
  sourceNetworkId: number;
  depositCount: number;
};

export type BuildClaimTransactionResponse = UnsignedTransaction;
