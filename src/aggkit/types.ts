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
