/**
 * aggkit Bridge Module
 *
 * Standalone module for talking to the aggkit `bridge/v1` REST service.
 * Kept separate from NATIVE/core so neither is touched by this integration
 * (design.md §4). S4 provides the single-network `AggkitBridgeClient`; S5
 * adds the multi-network `AggkitBridgeAggregator` (fan-out/join/
 * status-derivation/token-metadata, design.md §2-§5).
 *
 * ## Multi-Network Proxy Configuration
 *
 * A single `AggkitBridgeAggregator` instance can proxy all networks through
 * one physical backend URL when an AggKit proxy is deployed (design.md §0.1).
 * Create multiple clients with distinct `networkId` values pointed at the same
 * base URL:
 *
 * ```typescript
 * const aggregator = new AggkitBridgeAggregator({
 *   networks: {
 *     1: { baseUrl: "http://proxy.local:8080", networkId: 1 },
 *     2: { baseUrl: "http://proxy.local:8080", networkId: 2 }, // Same URL, different networkId
 *   },
 * });
 * ```
 *
 * The proxy multiplexes networks via `?network_id=` query parameter; the URL
 * is the same for all networks. This is the correct configuration for devnets
 * with an aggkit-proxy service fronting multiple L2s.
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
  AggkitTrackingStatus,
  AggkitTrackingStatusString,
  AggkitBridgeType,
  AggkitBridgeTypeString,
  AggkitBridgeLeafType,
  AggkitBridgeLeafTypeString,
  AggkitBridgeStep,
  AggkitBridgeStepString,
  AggkitStepStatus,
  AggkitStepStatusString,
  AggkitTrackerErrorType,
  AggkitTrackerErrorTypeString,
  AggkitCertificateStatus,
  AggkitCertificateStatusString,
  AggkitBridgeStatus,
  AggkitTrackerErrorStep,
  AggkitCertificateData,
  AggkitWaitingGERUpdateResult,
  AggkitWaitingLERUpdateResult,
  AggkitPendingInclusionResult,
  AggkitWaitL1SettledGERResult,
  AggkitWaitingGERInjectionResult,
  AggkitWaitingClaimResult,
  AggkitBridgeStepResult,
  AggkitBridgeStepPath,
  AggkitTrackingData,
  AggkitTrackerErrorData,
} from './types';
