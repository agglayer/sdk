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
 *
 * ## Bridge Tracking
 *
 * `AggkitBridgeClient.getBridgeTracking` / `AggkitBridgeAggregator.getBridgeTracking`
 * (S8/S9) poll aggkit's `tracker/v1` REST API for a single bridge transaction's
 * step-by-step progress (registers the tx on first call). See the JSDoc on
 * those methods for terminal-state/polling guidance, and the
 * `AggkitTrackingData` family in `types.ts` for the full wire-format
 * reference. That reference was captured off a live devnet and matches
 * aggkit's `docs/bridgetracker/API.md` as corrected by v0.11.0-rc5
 * (agglayer/aggkit#1784): most enums ship as bare strings (no numeric +
 * `_string` pairs — only `error_type` and certificate `status` keep that
 * convention), and steps carry `step_name`, not `step`. rc4's API.md
 * described these differently; the wire format itself never changed.
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
  AggkitBridgeType,
  AggkitBridgeLeafType,
  AggkitBridgeStep,
  AggkitStepStatus,
  AggkitTrackerErrorType,
  AggkitTrackerErrorTypeString,
  AggkitCertificateStatus,
  AggkitCertificateStatusString,
  AggkitBridgeStatusEvent,
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
