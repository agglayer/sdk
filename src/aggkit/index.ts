/**
 * aggkit Bridge Module
 *
 * Standalone module for talking to the aggkit `bridge/v1` REST service.
 * Kept separate from NATIVE/core so neither is touched by this integration.
 * Provides the single-network `AggkitBridgeClient` and the multi-network
 * `AggkitBridgeAggregator` (fan-out/join/status-derivation/token-metadata).
 *
 * ## Multi-Network Proxy Configuration
 *
 * A single `AggkitBridgeAggregator` instance can proxy all networks through
 * one physical backend URL when an AggKit proxy is deployed.
 * Create multiple clients with distinct `networkId` values pointed at the same
 * base URL:
 *
 * ```typescript
 * const aggregator = new AggkitBridgeAggregator({
 *   networks: {
 *     1: "http://proxy.local:8080",
 *     2: "http://proxy.local:8080", // Same URL, different networkId
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
 *
 * ## Claim Inputs & the Not-Ready Union
 *
 * `AggkitBridgeAggregator.getClaimInputs` returns
 * `AggkitClaimInputsResult = AggkitClaimInputsReady | AggkitClaimInputsNotReady`
 * (discriminated on `claimable`). Not yet claimable is data, not an error:
 * `getClaimInputs` returns `{ claimable: false, reason, detail }` for a valid
 * request whose deposit simply has not settled yet -- it never throws for
 * that condition. It throws only for genuine failures: `AggkitApiError` for
 * a real non-2xx response, a plain `Error` for a backend-contract violation
 * or a configuration problem, or a plain `Error` (its `.cause` carries the
 * original network error) for a transport failure after retries are
 * exhausted -- a transport failure does NOT produce `AggkitApiError`;
 * that class is only ever constructed from an actual HTTP response. There is
 * no thrown not-ready state anywhere on this path.
 *
 * `reason` (`AggkitNotReadyReason`) is an OPEN string-literal union that WILL
 * gain members as aggkit's error taxonomy evolves. It currently has five
 * members: `SOURCE_NOT_ON_L1_INFO_TREE`, `DESTINATION_GER_NOT_INJECTED`,
 * `SYNCER_INCONSISTENT` (a transient reorg-resolution wait, reachable from
 * all three claim-path endpoints -- `/l1-info-tree-index`,
 * `/injected-l1-info-leaf`, and `/claim-proof`), `L1_INFO_LEAF_NOT_INDEXED`,
 * and `CLAIM_PROOF_NOT_AVAILABLE`. Always branch with a `default` / `else`
 * that treats an unrecognised reason as "not ready yet, keep polling" --
 * never write an exhaustive `switch` with an `assertNever` default, or a
 * future non-breaking SDK minor becomes a breaking change for you. `detail`
 * is a human-readable string for logging/display only; never branch on its
 * text.
 *
 * The lower-level client probes (`AggkitBridgeClient.getL1InfoTreeIndex`,
 * `getInjectedL1InfoLeaf`, `getClaimProof`) return the same-shaped
 * `AggkitProbeResult<T>` union (`{ ready: true; value: T } | { ready: false;
 * reason; detail }`), with identical not-error semantics.
 *
 * ## Recording-Network Routing
 *
 * `getClaimInputs` takes a REQUIRED `recordingNetworkId` -- the network whose
 * LOCAL EXIT TREE recorded the deposit (i.e. the network the bridging
 * transaction executed on) -- NOT the asset's `origin_network`. The two
 * diverge for native-gas-token withdrawals and for cross-network transfers
 * of a token whose origin differs from the network the transfer executed
 * on; passing `origin_network` there silently builds a well-formed claim
 * proof for a different, unrelated deposit, with no error raised anywhere.
 * From `getActivity` / `getReadyToClaimCount` rows the correct value is
 * `AggkitTransaction.sourceNetwork`. There is no `originNetworkId`
 * parameter -- it was removed, not deprecated, so a stale call site is a
 * compile error rather than a silently wrong proof.
 *
 * ## Minimum Supported aggkit Version
 *
 * **v0.11.0-rc6.** Earlier releases (rc4/rc5) are not supported — this SDK
 * does not attempt to classify their wire shapes, so a deployment on rc4/rc5
 * will see a genuine failure (`AggkitApiError`) for any not-ready state these
 * endpoints report, rather than the `{ claimable: false, reason, detail }`
 * union described above. On the supported floor, the client absorbs
 * aggkit's not-ready wire shapes across `/l1-info-tree-index`,
 * `/injected-l1-info-leaf`, and `/claim-proof` into the same stable
 * `AggkitNotReadyReason` members — a 404 with a fixed not-ready prose, or a
 * 503 while a syncer resolves a reorg (`SYNCER_INCONSISTENT`) — while any
 * 500 on any of the three is unconditionally a genuine fault and keeps
 * throwing `AggkitApiError`.
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
  AggkitNotReadyReason,
  AggkitProbeResult,
  AggkitClaimInputsParams,
  AggkitClaimInputsReady,
  AggkitClaimInputsNotReady,
  AggkitClaimInputsResult,
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
