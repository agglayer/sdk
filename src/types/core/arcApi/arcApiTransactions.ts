/**
 * Arc API Transactions Types
 *
 * Defines the core request and response types for the transactions endpoint.
 */

import type { CursorPagination } from './_arcApiBase';

export interface Transaction {
  // Universal identifiers
  id: string; // Primary key: transactionId for LiFi, hubUID for Agglayer
  transactionHash: string; // Main transaction hash
  bridgeHash: string | null; // Bridge-specific hash (Agglayer has this, LiFi uses transactionId)

  // Protocol specific
  protocols: string[]; // "LIFI", "AGGLAYER"
  status: string; // "BRIDGED", "LEAF_INCLUDED", "READY_TO_CLAIM", "CLAIMED", "REFUND_IN_PROGRESS", "REFUNDED"
  timestamp: number;

  // Address information
  fromAddress: string;
  toAddress: string; // receiverAddress for Agglayer

  sending: {
    txHash: string; // Main transaction hash, Agglayer bridge tx hash
    network: {
      chainId: number;
      networkId: number | null; // Agglayer uses networkId, LiFi uses chainId
    };
    timestamp: number;
    token: {
      originTokenAddress: string;
      originTokenNetwork: number | null; // Agglayer specific
    };
    amount: string;
    includedSteps: unknown[] | null; // LiFi specific
  };
  receiving: {
    txHash: string | null; // Agglayer claim tx hash
    network: {
      chainId: number;
      networkId: number | null; // Agglayer uses networkId, LiFi uses chainId
    };
    timestamp: number | null;
    amount: string;
    tokenAddress: string;
  } | null;

  // Agglayer specific fields
  leafType: string | null;
  depositCount: number | null;
  transactionIndex: number | null;
  blockNumber: number | null;
  leafIndex: number | null;

  // Metadata
  metadata: {
    integrator: string | null;
    feeCosts: unknown[] | null; // LiFi specific
  };
}

export interface TransactionsRequestQueryParams {
  readonly address?: string;
  readonly sourceNetworkIds?: string;
  readonly destinationNetworkIds?: string;
  readonly limit?: number;
  readonly startAfter?: number;
}

export type TransactionsResponse = Transaction[];

// For exposing paginated response
export interface PaginatedTransactionsResponse {
  readonly transactions: TransactionsResponse;
  readonly pagination?: CursorPagination;
}
