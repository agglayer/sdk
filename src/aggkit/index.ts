/**
 * aggkit Bridge Module
 *
 * Standalone module for talking to the aggkit `bridge/v1` REST service.
 * Kept separate from NATIVE/core so neither is touched by this integration
 * (design.md §4). S4 provides the single-network `AggkitBridgeClient`; S5
 * adds the multi-network `AggkitBridgeAggregator` (fan-out/join/
 * status-derivation/token-metadata, design.md §2-§5).
 */

export { AggkitBridgeClient } from './client';
export { AggkitBridgeAggregator } from './aggregator';
export { AggkitApiError } from './errors';
export type { AggkitApiErrorArgs } from './errors';

export type {
  AggkitBridgeClientConfig,
  AggkitBridgesResult,
  AggkitClaimsResult,
  AggkitTokenMappingsResult,
  AggkitBridge,
  AggkitClaim,
  AggkitClaimProof,
  AggkitL1InfoTreeLeaf,
  AggkitTokenMapping,
  AggkitSyncStatus,
  AggkitSyncStatusInfo,
  AggkitHealthResponse,
  AggkitErrorBody,
  AggkitAggregatorConfig,
  AggkitTransactionStatus,
  AggkitTransaction,
  AggkitFailedNetwork,
  AggkitActivityPage,
  AggkitPageCursor,
  AggkitTokenMetadata,
} from './types';
