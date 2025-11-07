/**
 * Arc API Transactions Types
 *
 * Defines the core request and response types for the transactions endpoint.
 */

import type { CursorPagination } from './_arcApiBase';

export enum TransactionStatus {
  BRIDGED = 'BRIDGED',
  LEAF_INCLUDED = 'LEAF_INCLUDED',
  READY_TO_CLAIM = 'READY_TO_CLAIM',
  CLAIMED = 'CLAIMED',
  REFUND_IN_PROGRESS = 'REFUND_IN_PROGRESS',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
  PARTIAL = 'PARTIAL',
}

interface Token {
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
}

interface SendingToken extends Token {
  // Agglayer specific
  originTokenAddress: string;
  originTokenNetwork: number | null; // Agglayer specific
}

interface ReceivingToken extends Token {
  tokenAddress: string;
}

interface IntermediateToken extends Token {
  tokenAddress: string;
}

interface Network {
  chainId: number;
  networkId: number | null; // Agglayer uses networkId, LiFi uses chainId
}

interface Step {
  txHash: string;
  network: Network;
  timestamp: number;
  amount: string;
  amountUSD: string;
  includedSteps: unknown[];
}

interface SendingStep extends Step {
  token: SendingToken;
}

interface ReceivingStep extends Step {
  token: ReceivingToken;
}

interface IntermediateStep extends Step {
  token: IntermediateToken;
}

export interface Transaction {
  // Universal identifiers
  id: string; // Primary key: transactionId for LiFi, hubUID for Agglayer
  transactionHash: string; // Main transaction hash

  // Protocol specific
  protocols: string[]; // "LIFI", "AGGLAYER"
  status: string; // "BRIDGED", "LEAF_INCLUDED", "READY_TO_CLAIM", "CLAIMED", "REFUND_IN_PROGRESS", "REFUNDED"

  // Address information
  fromAddress: string;
  toAddress: string; // receiverAddress for Agglayer

  sending: SendingStep;
  receiving: ReceivingStep | null;

  intermediateSteps: IntermediateStep[];

  transactionHashes: string[];

  // Metadata
  metadata: {
    integrator: string | null;
    feeCosts: unknown[] | null; // LiFi specific
    // Agglayer specific fields
    leafType: string | null;
    depositCount: number | null;
  };
  lastUpdatedAt: number;
}

export interface TransactionsRequestQueryParams {
  readonly address?: string;
  readonly sourceChainIds?: number[];
  readonly destinationChainIds?: number[];
  readonly statuses?: TransactionStatus[];
  readonly limit?: number;
  readonly startAfter?: number;
}

export type TransactionsResponse = Transaction[];

// For exposing paginated response
export interface PaginatedTransactionsResponse {
  readonly transactions: TransactionsResponse;
  readonly pagination?: CursorPagination;
}
