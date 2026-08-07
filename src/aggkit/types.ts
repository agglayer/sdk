/**
 * aggkit Bridge REST API — types
 *
 * Canonical TypeScript shapes for the aggkit `bridge/v1` REST surface, derived
 * from live fixtures + aggkit `types.go`. See
 * `/home/brolygon/repos/plans/aggkit-migration/design.md` §1.1 for the
 * fixture-backed derivation of every field.
 *
 * IMPORTANT: `global_index` is a bare JSON number on `/bridges` (exceeds
 * Number.MAX_SAFE_INTEGER) but a JSON string on `/claims`. Both are carried
 * here as `string` — see `AggkitBridgeClient` (`../aggkit/client.ts`) for the
 * BigInt-safe parsing that guarantees this invariant.
 */

/** Config for a single-network aggkit bridge-service client. */
export interface AggkitBridgeClientConfig {
  /** e.g. "http://127.0.0.1:33460" (WITHOUT `/bridge/v1`; the client appends it). */
  baseUrl: string;
  /** The L2 network id this aggkit instance serves. */
  networkId: number;
  /** Request timeout in ms. Default 30000 (matches `HttpClient`'s default). */
  timeout?: number;
  /** Max retry attempts on retryable (network/timeout) errors. Default 3. */
  retries?: number;
  /** Base retry backoff delay in ms (exponential). Default 1000. */
  retryDelay?: number;
}

// ---- BARE list envelopes ----

export interface AggkitBridgesResult {
  bridges: AggkitBridge[];
  count: number;
}

export interface AggkitClaimsResult {
  claims: AggkitClaim[];
  count: number;
}

export interface AggkitTokenMappingsResult {
  token_mappings: AggkitTokenMapping[];
  count: number;
}

// ---- bridge row (global_index parsed from a bare JSON number into a string) ----

export interface AggkitBridge {
  block_num: number;
  block_pos: number;
  /** May be "" or absent; do not trust for identity beyond sender display. */
  from_address: string;
  tx_hash: string;
  /** Parsed from a bare JSON number, quoted before JSON.parse — see client.ts. */
  global_index: string;
  /** Unix seconds. */
  block_timestamp: number;
  /** 0 = asset, 1 = message. */
  leaf_type: number;
  origin_network: number;
  /** Origin TOKEN address (0x0 = native). */
  origin_address: string;
  destination_network: number;
  destination_address: string;
  /** Decimal wei. */
  amount: string;
  /** "0x" for native. */
  metadata: string;
  /** Local leaf index in the origin tree. */
  deposit_count: number;
  /** Unique id. */
  bridge_hash: string;
  txn_sender: string;
  to_address: string;
}

// ---- claim row (global_index is already a JSON string) ----

export interface AggkitClaim {
  block_num: number;
  block_timestamp: number;
  tx_hash: string;
  global_index: string;
  origin_address: string;
  origin_network: number;
  destination_address: string;
  destination_network: number;
  amount: string;
  /** ALWAYS "" in the captured dataset — never use for identity. */
  from_address: string;
  mainnet_exit_root: string;
  rollup_exit_root: string;
  global_exit_root: string;
  metadata: string;
  is_message: boolean;
  /** Only present with `includeAllFields: true`. */
  proof_local_exit_root?: string[];
  /** Only present with `includeAllFields: true`. */
  proof_rollup_exit_root?: string[];
}

// ---- claim proof ----

export interface AggkitL1InfoTreeLeaf {
  block_num: number;
  block_pos: number;
  l1_info_tree_index: number;
  previous_block_hash: string;
  timestamp: number;
  mainnet_exit_root: string;
  rollup_exit_root: string;
  global_exit_root: string;
  hash: string;
}

export interface AggkitClaimProof {
  /** 32 hashes. */
  proof_local_exit_root: string[];
  /** 32 hashes (all-zero in a single-L2 setup). */
  proof_rollup_exit_root: string[];
  l1_info_tree_leaf: AggkitL1InfoTreeLeaf;
}

// ---- token mapping ----

export interface AggkitTokenMapping {
  block_num: number;
  block_pos: number;
  block_timestamp: number;
  tx_hash: string;
  origin_network: number;
  origin_token_address: string;
  wrapped_token_address: string;
  metadata: string;
  /** 0 = wrapped, 1 = sovereign. */
  token_type: number;
  is_not_mintable: boolean;
}

// ---- sync status ----

export interface AggkitSyncStatusInfo {
  contract_deposit_count: number;
  synchronized_deposit_count: number;
  is_synced: boolean;
  is_active: boolean;
}

export interface AggkitSyncStatus {
  l1_info: AggkitSyncStatusInfo;
  l2_info: AggkitSyncStatusInfo;
}

// ---- root health check ----
// Not part of the `/bridge/v1` surface (served at the instance root), but
// captured as a fixture and requested as an S4 deliverable type.

export interface AggkitHealthResponse {
  status: string;
  time: string;
  version: string;
}

// ---- error body (every non-2xx response) ----

export interface AggkitErrorBody {
  error: string;
}

/**
 * ---- Aggregator (S5): multi-network fan-out + status derivation ----
 *
 * See `/home/brolygon/repos/plans/aggkit-migration/design.md` §2-§5 for the
 * fan-out/join/status-derivation/token-metadata algorithms these types
 * support, and `aggregator.ts` for the implementation.
 */

/** Config for the multi-network aggregator: one aggkit base URL per L2 networkId. */
export interface AggkitAggregatorConfig {
  /** Map of L2 networkId -> aggkit REST base URL (no `/bridge/v1` suffix). */
  networks: Record<number, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

/**
 * UI transaction status (`app/types/transaction.ts` `TransactionStatus`).
 *
 * State machine (design.md §3.2–§3.3):
 * - **BRIDGED**: Deposit emitted on source, not yet included in L1 info tree.
 * - **LEAF_INCLUDED**: Deposit included in L1 info tree on source; for L2 destinations
 *   only: the source leaf exists but the destination's GER injection lags (common in
 *   fresh enclaves where L2 block height exceeds L1). Destination's injected leaf will
 *   eventually catch up. For L1 destinations, this state never occurs (L1 has no "injection"
 *   concept — leaf inclusion suffices).
 * - **READY_TO_CLAIM**: Claim proof available; user can call `claimAsset` on destination.
 *   For L1 destinations: source leaf included. For L2 destinations: both source included
 *   AND destination injected.
 * - **CLAIMED**: Claim completed on destination; balance received.
 */
export type AggkitTransactionStatus =
  'BRIDGED' | 'LEAF_INCLUDED' | 'READY_TO_CLAIM' | 'CLAIMED';

/**
 * UI-shaped transaction row (mirrors `app/types/transaction.ts` `Transaction`
 * field-for-field per design.md §3.6). Produced by `AggkitBridgeAggregator`
 * from a joined + status-derived `AggkitBridge` row.
 */
export interface AggkitTransaction {
  hubUID: string;
  txSender: string;
  fromAddress: string;
  receiverAddress: string;
  sourceNetwork: number;
  destinationNetwork: number;
  amount: string;
  status: AggkitTransactionStatus;
  lastUpdatedAt: number;
  bridgeHash: string;
  metadata: string;
  leafType: string;
  depositCount: number;
  transactionIndex: number;
  transactionHash: string;
  claimTransactionHash?: string;
  claimTimestamp?: number;
  claimBlockNumber?: number;
  blockNumber: number;
  globalIndex: string;
  originTokenAddress: string;
  originTokenNetwork: number;
  timestamp: number;
  /** For `Bridge.isClaimed` — equals `deposit_count`, NOT the L1-info-tree index (design.md §7.1). */
  leafIndex: number;
  /** The L1-info-tree index (for `/claim-proof`'s `leaf_index`); only set once probed (Tier 2). */
  leafIndexForProof?: number;
}

/** One configured network's fan-out failed; its rows are simply absent from the page (design.md §2.4). */
export interface AggkitFailedNetwork {
  networkId: number;
  error: string;
  httpStatus?: number;
}

/** Result of `AggkitBridgeAggregator.getActivity` (design.md §2.4). */
export interface AggkitActivityPage {
  data: AggkitTransaction[];
  pagination: {
    total: number;
    limit: number;
    nextStartAfterCursor?: string;
  };
  failedNetworks: AggkitFailedNetwork[];
}

/**
 * Opaque composite cursor: one 1-based page counter per fan-out call
 * (design.md §2.3). A stored value of `0` is a sentinel meaning "this call
 * is exhausted — do not refetch it" (an S5 implementation detail resolving
 * an edge case the design doc leaves implicit; see aggregator.ts).
 */
export type AggkitPageCursor = Record<string, number>;

/**
 * Token metadata output shape = UI's existing `TokenMetadata`
 * (`app/services/tokenMetadata.ts`), unchanged so the UI consumer contract
 * does not need to change (design.md §5.2).
 */
export interface AggkitTokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  tokenAddress: string;
  network?: number | string;
  totalSupply?: string;
  logoURI?: string;
  originTokenAddress?: string;
  originTokenNetwork?: number | string;
  wrappedTokenAddressV1?: string;
  wrappedTokenAddressV2?: string;
}

/**
 * ---- Bridge Tracker (S4/S5): aggkit `tracker/v1` REST API, v0.11.0-rc4 ----
 *
 * Canonical TypeScript shapes for `GET /tracker/v1/network/{network_id}/tx/{tx_hash}`
 * (and its `health` sibling). S4 derived these verbatim from aggkit
 * `v0.11.0-rc4:docs/bridgetracker/API.md`; S5 reconciled them against LIVE
 * fixtures captured off a real rc4 enclave
 * (`/home/brolygon/repos/plans/bridge-tracker/fixtures/`, see that
 * directory's `README.md` "Deviation / bug found #2" for the writeup) —
 * the fixtures are treated as the source of truth wherever they disagree
 * with API.md, which turned out to be in more places than the docs' own
 * "numeric + `_string` companion" convention would suggest:
 *
 * - `tracking_status`, `bridge_type`, and `status` (the step's) ship as
 *   BARE STRINGS on the wire — no numeric value, no `<field>_string`
 *   companion, despite API.md's documented convention.
 * - The step's enum field is not named `step` at all — it's `step_name`,
 *   also a bare string. Each step entry additionally carries a `step_index`
 *   integer (redundant with the entry's position in `all_steps`) that
 *   API.md does not document.
 * - `bridge_leaf_type` isn't a sibling of `bridge_type` on `BridgeStatus`;
 *   it (also a bare string, same deviation) lives one level down, nested
 *   inside an `event` object alongside the origin/destination/amount fields
 *   API.md never mentions as part of `BridgeStatus` at all.
 * - Per-step `start_date`/`end_date`/`result`/`error` are OMITTED keys when
 *   not yet applicable (e.g. a `pending` step has none of them), not `null`
 *   — confirmed directly from raw fixture JSON, never a `"start_date": null`
 *   anywhere. `expected_duration` was never observed on the wire at all, in
 *   any step, at any status — kept as an optional field in case a future
 *   aggkit build starts emitting it, but unconfirmed.
 * - `error_type` (`ErrorStep`) and `status` (`CertificateData`) DO match
 *   the documented numeric + `_string` companion convention exactly — this
 *   deviation is selective, not blanket.
 * - `CertificateData.settlement_tx_hash` is an OMITTED key (not `null`)
 *   until a certificate leaves `Pending`, confirmed by fixtures.
 *   `CertificateData.previous_ler`'s documented "`null` for a network's
 *   first certificate" case was never exercised by any fixture (every
 *   capture already had prior certificates) — kept as `string | null` per
 *   the docs, unconfirmed either way.
 *
 * Top-level `TrackingData` fields that ARE documented as nullable
 * (`bridge_status`/`step_index`/`all_steps`/`error`) DO serialize as
 * explicit JSON `null`, confirmed by fixtures (e.g. `"error": null` appears
 * verbatim throughout) — that part of the docs holds. Dates
 * (`start_date`/`end_date`) stay ISO strings as received (never constructed
 * into `Date` in the SDK).
 */

// ---- enums ----

/**
 * `TrackingData.tracking_status`: bare string on the wire (fixture-confirmed)
 * — no numeric value, no `tracking_status_string` companion despite API.md.
 */
export type AggkitTrackingStatus =
  'registered' | 'running' | 'error' | 'finished';

/**
 * `BridgeStatus.bridge_type`: bare string on the wire (fixture-confirmed) —
 * no numeric value, no `bridge_type_string` companion despite API.md.
 */
export type AggkitBridgeType = 'L1->L2' | 'L2->L1' | 'L2->L2';

/**
 * `BridgeStatus.event.leaf_type`: bare string on the wire (fixture-confirmed,
 * same deviation as `bridge_type`) — lives nested under `event`, not as a
 * `BridgeStatus`-level `bridge_leaf_type`/`bridge_leaf_type_string` pair as
 * API.md documents. Only `'Asset'` was directly observed (all captured
 * bridges were `bridgeAsset`); `'Message'` is the documented sibling value.
 */
export type AggkitBridgeLeafType = 'Asset' | 'Message';

/**
 * `BridgeStepPath.step_name`: bare string on the wire (fixture-confirmed) —
 * the field isn't even named `step`, and there is no numeric value or
 * `step_string` companion despite API.md.
 */
export type AggkitBridgeStep =
  | 'WaitingGERUpdate'
  | 'WaitingLERUpdate'
  | 'PendingInclusion'
  | 'CertificatePending'
  | 'WaitL1SettledGER'
  | 'WaitingGERInjection'
  | 'WaitingClaim'
  | 'Claimed';

/**
 * `BridgeStepPath.status`: bare string on the wire (fixture-confirmed) — no
 * numeric value, no `status_string` companion despite API.md.
 */
export type AggkitStepStatus = 'pending' | 'inProgress' | 'done' | 'error';

/**
 * `ErrorStep.error_type`: 0->transient, 1->permanent, 2->exhausted (retries
 * have been given up on). Fixture-confirmed to match API.md's documented
 * numeric + `_string` companion convention exactly.
 */
export type AggkitTrackerErrorType = 0 | 1 | 2;
/** `ErrorStep.error_type_string`. */
export type AggkitTrackerErrorTypeString =
  'transient' | 'permanent' | 'exhausted';

/**
 * `CertificateData.status`: mapped from the agglayer proto (aggkit
 * `agglayer_grpc_client.go`): 0->Pending, 1->Proven, 2->Candidate,
 * 3->InError, 4->Settled. Fixture-confirmed to match API.md's documented
 * numeric + `_string` companion convention exactly.
 */
export type AggkitCertificateStatus = 0 | 1 | 2 | 3 | 4;
/** `CertificateData.status_string`. */
export type AggkitCertificateStatusString =
  'Pending' | 'Proven' | 'Candidate' | 'InError' | 'Settled';

// ---- shared structures ----

/**
 * `BridgeStatus.event`: the underlying `BridgeEvent` (bridgeAsset/
 * bridgeMessage) log that seeded this bridge. Nested under `bridge_status.
 * event` on the wire — API.md does not document this nesting (or these
 * fields as part of `BridgeStatus` at all); confirmed by every lifecycle
 * fixture.
 */
export interface AggkitBridgeStatusEvent {
  leaf_type: AggkitBridgeLeafType;
  origin_network: number;
  /** Origin TOKEN address (0x0 = native). */
  origin_address: string;
  destination_network: number;
  destination_address: string;
  /** Decimal wei. */
  amount: string;
  /** Local leaf index in the origin tree. */
  deposit_count: number;
}

/**
 * `TrackingData.bridge_status`: `null` while `tracking_status` is
 * `registered`, and forever `null` if the tracker gives up resolving the
 * bridge (`AggkitTrackingData.error` is set instead).
 */
export interface AggkitBridgeStatus {
  bridge_type: AggkitBridgeType;
  /** Block, on the origin network, where the `BridgeEvent` was emitted. */
  block_number: number;
  /** Position of the `BridgeEvent` log within `block_number`. */
  log_index: number;
  /** Unix seconds; the origin block's timestamp. */
  block_timestamp: number;
  event: AggkitBridgeStatusEvent;
}

/**
 * Carried both in `AggkitBridgeStepPath.error` (that step of an otherwise-
 * resolved bridge failed) and in `AggkitTrackingData.error` (the tracker
 * gave up trying to resolve the bridge at all — tx not found, or the tx
 * exists but emitted no `BridgeEvent`). In the latter case `retry_count`
 * counts the not-found polls before giving up.
 */
export interface AggkitTrackerErrorStep {
  error_type: AggkitTrackerErrorType;
  error_type_string: AggkitTrackerErrorTypeString;
  retry_count: number;
  /** Human-readable description(s), one entry per occurrence. */
  description: string[];
}

/**
 * The agglayer certificate's current data; carried by the
 * `CertificatePending` step's `result` (set as soon as a certificate exists,
 * updated as its status changes, and reflects the final settled data once
 * `status` is `Settled`).
 */
export interface AggkitCertificateData {
  certificate_id: string;
  status: AggkitCertificateStatus;
  status_string: AggkitCertificateStatusString;
  /** Only set if the proto carries `Error.Message` (relevant for `InError` certs). */
  error?: string;
  /**
   * Omitted (not `null`) while `status` is still `Pending` — fixture-
   * confirmed (`lifecycle_l2l1`'s first `CertificatePending` snapshot has no
   * `settlement_tx_hash` key at all). Present from `Candidate` onward.
   */
  settlement_tx_hash?: string;
}

// ---- per-step `BridgeStepPath.result` shapes (StepResult, keyed by `step`) ----

/** `WaitingGERUpdate` step result: GER resulting from the L1 update, and where it landed. */
export interface AggkitWaitingGERUpdateResult {
  l1_info_tree_index: number;
  ger: string;
  mer: string;
  rer: string;
  block_number: number;
  block_timestamp: number;
  log_index: number;
}

/** `WaitingLERUpdate` step result: LER resulting from the origin L2 update. */
export interface AggkitWaitingLERUpdateResult {
  network_id: number;
  ler: string;
  block_number: number;
}

/** `PendingInclusion` step result: the certificate that first includes the bridge. */
export interface AggkitPendingInclusionResult {
  certificate_id: string;
  new_ler: string;
  /** `null` for a network's first certificate. */
  previous_ler: string | null;
}

/**
 * `WaitL1SettledGER` step result: evidence, read off the settlement tx
 * receipt once it reaches L1 finality, that the settlement propagated to the
 * L1 Global Exit Root.
 */
export interface AggkitWaitL1SettledGERResult {
  tx_hash: string;
  block_number: number;
  ger: string;
  /** Never `null` once the step is `done`; see aggkit `API.md` for the resolution rules. */
  l1_info_tree_index: number | null;
  has_verify_batches_trusted_aggregator: boolean;
  has_update_l1_info_tree: boolean;
  /** Informational only — unlike the other two `has_*` fields, not required for the step to complete. */
  has_update_l1_info_tree_v2: boolean;
}

/** `WaitingGERInjection` step result: GER injected on the destination network covering the bridge. */
export interface AggkitWaitingGERInjectionResult {
  ger: string;
}

/** `WaitingClaim` step result: the claim transaction on the destination network. */
export interface AggkitWaitingClaimResult {
  claim_tx: string;
  block_number: number;
}

/**
 * `BridgeStepPath.result`: shape depends on that entry's `step`.
 * `CertificatePending`'s result is the full `AggkitCertificateData`; steps
 * not covered by aggkit's `StepResult` table (i.e. `Claimed`) never carry a
 * result.
 */
export type AggkitBridgeStepResult =
  | AggkitWaitingGERUpdateResult
  | AggkitWaitingLERUpdateResult
  | AggkitPendingInclusionResult
  | AggkitCertificateData
  | AggkitWaitL1SettledGERResult
  | AggkitWaitingGERInjectionResult
  | AggkitWaitingClaimResult;

/**
 * One milestone of a bridge's expected route (`AggkitTrackingData.all_steps[i]`).
 * `start_date`/`end_date`/`result`/`error` are OMITTED keys (not `null`)
 * until applicable — fixture-confirmed: a `pending` step has none of these
 * keys, an `inProgress` step has only `start_date`, a `done` step has both
 * dates plus `result` (when that step produces one). `expected_duration`
 * was never observed on the wire in any fixture at any status.
 */
export interface AggkitBridgeStepPath {
  /** Position of this entry within `all_steps` (redundant with array index; not documented by API.md). */
  step_index: number;
  step_name: AggkitBridgeStep;
  status: AggkitStepStatus;
  start_date?: string;
  end_date?: string;
  /** Human-readable duration string (e.g. "5m0s"); never constructed into a `Date` here. Undocumented on the wire — never observed in any captured fixture. */
  expected_duration?: string;
  /** Present only once the step produces a result; absent for steps without one (e.g. `Claimed`). */
  result?: AggkitBridgeStepResult;
  /** Present only when `status` is `error`; see `AggkitTrackerErrorStep`. Never observed in captured fixtures. */
  error?: AggkitTrackerErrorStep;
}

/**
 * Body of every bridge-tracker REST response (always `200 OK`) and of every
 * WebSocket `status` message (WebSocket itself is a non-goal for this SDK
 * method). Calling `GET /tracker/v1/network/{network_id}/tx/{tx_hash}`
 * registers `tx_hash` in the tracker's supervised list if it was not already
 * tracked.
 */
export interface AggkitTrackingData {
  tracking_status: AggkitTrackingStatus;
  network_id: number;
  tx_hash: string;
  /** `null` under the same conditions as `step_index`/`all_steps` — see `error`. */
  bridge_status: AggkitBridgeStatus | null;
  /**
   * Index into `all_steps` of the step that explains `tracking_status`: the
   * step in progress when `running`, the step in error when `error`, or the
   * last step (`Claimed`) when `finished`.
   */
  step_index: number | null;
  /** All expected steps of the bridge's route; `null` until the tracker resolves it. */
  all_steps: AggkitBridgeStepPath[] | null;
  /**
   * Set only if the tracker gave up trying to resolve the bridge at all
   * (e.g. the tx does not exist on the network, or is not a bridge
   * transaction). Unrelated to per-step errors, which live in
   * `all_steps[i].error` instead.
   */
  error: AggkitTrackerErrorStep | null;
}

/**
 * Bridge-tracker `400` error body (`ErrorData`) — a DIFFERENT shape from the
 * bridge-service `AggkitErrorBody` (`{"error": "..."}`): the tracker uses
 * `{"code": ..., "message": "..."}` instead. Reserved for invalid path
 * parameters (`network_id`/`tx_hash`), before any bridge is registered; once
 * a bridge is registered, every outcome (including the tracker giving up on
 * it) is reported through `AggkitTrackingData.error` instead.
 */
export interface AggkitTrackerErrorData {
  /** HTTP-like error code: always 400 (invalid params). */
  code: number;
  message: string;
}
