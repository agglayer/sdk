/**
 * Arc API Built Transaction Types
 *
 * Defines the core request and response types for the built transaction endpoint.
 */

import { UnsignedTransaction } from './_arcApiUnsignedTransaction';
import { Step } from './arcApiRoutes';

// Types are reused, for consistency
export type BuildTransactionRequestBody = Step;

export type BuildTransactionResponse = UnsignedTransaction;
