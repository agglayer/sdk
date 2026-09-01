/**
 * AggkitBridgeAggregator
 *
 * Multi-network aggregation + status derivation + token metadata over one
 * `AggkitBridgeClient` per configured L2 network: activity fan-out/merge/
 * cursor, the status-derivation state machine, the cheap ready-to-claim
 * count, claim-input orchestration and token-metadata composition.
 */

import { AggkitBridgeClient } from './client';
import { AggkitApiError } from './errors';
import { chainRegistry } from '../native/chains/registry';
import { ERC20 } from '../native';
import { ZERO_ADDRESS } from '../constants';
import type {
  AggkitAggregatorConfig,
  AggkitActivityPage,
  AggkitBridge,
  AggkitClaim,
  AggkitClaimInputsParams,
  AggkitClaimInputsResult,
  AggkitFailedNetwork,
  AggkitNotReadyReason,
  AggkitPageCursor,
  AggkitTokenMetadata,
  AggkitTrackingData,
  AggkitTransaction,
  AggkitTransactionStatus,
} from './types';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/** Sentinel cursor value: this fan-out call is exhausted, never refetch it. */
const EXHAUSTED = 0;

function clampPageSize(pageSize: number | undefined): number {
  const size = pageSize ?? DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

/**
 * Accepts ONLY a value that is unambiguously a non-negative integer:
 * either a `number` that is itself `Number.isInteger` and `>= 0`, or a
 * non-empty digits-only `string` (`/^\d+$/` -- no sign, no decimal point,
 * no exponent, no surrounding whitespace, no radix prefix) whose numeric
 * value is a safe non-negative integer. A blanket `Number(value)` coercion
 * is deliberately NOT used here: `Number(null)`, `Number("")`,
 * `Number([])`, and `Number(false)` all evaluate to `0`, and `Number(true)`
 * evaluates to `1` -- silently accepting those as legitimate cursor state
 * (0 = EXHAUSTED, 1 = page 1) instead of rejecting them as junk.
 */
function isValidCursorPageNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const num = Number(value);
    return Number.isSafeInteger(num) && num >= 0;
  }
  return false;
}

/**
 * Decodes a `nextStartAfterCursor` string into per-call page-number state.
 * Coerces every entry and drops anything that isn't a non-negative integer
 * (0 is `EXHAUSTED`, a legitimate sentinel -- not junk, but a junk value
 * that merely COERCES to 0, e.g. `null`/`""`/`[]`/`false`, must NOT be
 * accepted as that sentinel -- see `isValidCursorPageNumber`) -- e.g.
 * `{"1:bridgesOrigin": "abc"}` would otherwise survive the
 * `typeof === 'object'` check (so would an array) and `stored ?? 1` would
 * pass "abc" straight through to `runPaginatedCall`, reaching aggkit as
 * `page_number=abc`, which 400s and fails the whole network's fan-out
 * (comment 3862897288).
 */
export function decodeCursor(cursor: string | undefined): AggkitPageCursor {
  if (!cursor) {
    return {};
  }
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: AggkitPageCursor = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (isValidCursorPageNumber(value)) {
        result[key] = typeof value === 'number' ? value : Number(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function isNativeTokenAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}

/**
 * Compares two `global_index` values for equality, normalizing first via
 * `BigInt` so a differing bigint/string/number representation (e.g. a
 * leading-zero string, or a future numeric-typed value) doesn't produce a
 * false negative -- see `parsing.ts`'s `quoteGlobalIndex` for why
 * `global_index` needs BigInt-safe handling at all (it exceeds
 * `Number.MAX_SAFE_INTEGER` for L1-origin deposits). Falls back to a strict
 * string comparison if either side isn't BigInt-parseable.
 */
function globalIndexesMatch(
  a: string | number | bigint,
  b: string | number | bigint
): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return String(a) === String(b);
  }
}

/** One page of a single paginated fan-out call. */
interface CallPageResult<T> {
  items: T[];
  count: number;
  /** Next 1-based page number to request, or `undefined` if exhausted. */
  nextPage: number | undefined;
}

/**
 * Runs one fan-out call honoring the composite cursor: if this call was
 * previously marked exhausted (`EXHAUSTED` sentinel), skip it entirely;
 * otherwise fetch the page recorded in the cursor (default 1) and compute
 * whether more pages remain.
 */
async function runPaginatedCall<T>(
  cursorState: AggkitPageCursor,
  key: string,
  pageSize: number,
  fetchPage: (pageNumber: number) => Promise<{ items: T[]; count: number }>
): Promise<CallPageResult<T>> {
  const stored = cursorState[key];
  if (stored === EXHAUSTED) {
    return { items: [], count: 0, nextPage: undefined };
  }

  const pageNumber = stored ?? 1;
  const { items, count } = await fetchPage(pageNumber);
  const hasMore = pageNumber * pageSize < count;

  return { items, count, nextPage: hasMore ? pageNumber + 1 : undefined };
}

function mergeClaimsMap(
  dest: Map<number, Map<string, AggkitClaim>>,
  networkId: number,
  src: Map<string, AggkitClaim>
): void {
  const existing = dest.get(networkId) ?? new Map<string, AggkitClaim>();
  for (const [key, value] of src) {
    existing.set(key, value);
  }
  dest.set(networkId, existing);
}

/** One bridge row plus the networkId of the aggkit instance it was fetched from. */
interface FetchedBridgeRow {
  bridge: AggkitBridge;
  /** The configured L2 network whose instance this row was fetched via. */
  sourceInstanceNetworkId: number;
  /**
   * The network whose LOCAL EXIT TREE recorded this deposit — i.e. the
   * `network_id` the fan-out call itself used, NOT `bridge.origin_network`.
   * Call A (`getBridges({ networkId: n })`)
   * rows are recorded on n's own tree, so `recordingNetworkId === n`. Call B
   * (`getBridges({ networkId: 0, networkIds: [n] })`) rows are recorded on
   * L1's tree, so `recordingNetworkId === 0`.
   *
   * This coincides with `bridge.origin_network` for genuine L1-origin
   * deposits (call B, origin 0) and genuine L2-origin tokens (call A,
   * origin n) — but NOT for withdrawals of an L2's native gas token, which
   * mirrors L1 ETH (`origin_network` is always 0) yet is recorded on the
   * L2's OWN tree (call A, so `recordingNetworkId === n`). Use this field,
   * not `bridge.origin_network`, when probing `/l1-info-tree-index`.
   */
  recordingNetworkId: number;
}

/** Result of fanning out the four calls (A-D) for one configured network. */
interface NetworkFanoutResult {
  networkId: number;
  bridgeRowsA: AggkitBridge[];
  bridgeRowsB: AggkitBridge[];
  /** Claims landed on this network (destination = networkId). */
  claimsHere: Map<string, AggkitClaim>;
  /** Claims landed on L1, as seen via this network's own L1 syncer. */
  claimsL1: Map<string, AggkitClaim>;
  /** Sum of A.count + B.count, for `pagination.total`. */
  totalBridgesCount: number;
  /** Updated cursor entries for this network's 4 fan-out calls. */
  nextCursorPatch: AggkitPageCursor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds a failed-network attribution from a caught error. */
function toFailedNetwork(
  networkId: number,
  error: unknown
): AggkitFailedNetwork {
  return {
    networkId,
    error: errorMessage(error),
    ...(error instanceof AggkitApiError
      ? { httpStatus: error.httpStatus }
      : {}),
  };
}

/**
 * Result of resolving the destination-injected L1-info-tree leaf a deposit's
 * `/claim-proof` must be built against (a proof built on the deposit's own
 * source index reverts GlobalExitRootInvalid until the destination has
 * injected a GER at-or-after it).
 */
type InjectedLeafResolution =
  | { kind: 'resolved'; leafIndex: number } // injected (or destination is L1)
  // The destination-side probe answered "valid request, not ready yet".
  // `reason` is the CLIENT's machine-readable reason, carried through
  // unmodified, and `detail` is aggkit's own wording propagated verbatim
  // rather than re-fabricated by the caller.
  //
  // Was `kind: 'not-injected'` with the reason hard-coded to
  // `'DESTINATION_GER_NOT_INJECTED'` at the `getClaimInputs` call site. That
  // silently rewrote every other not-ready reason this endpoint can now answer
  // with (`L1_INFO_LEAF_NOT_INDEXED`, `SYNCER_INCONSISTENT` — audit finding
  // C2), telling consumers the destination had not injected the GER when the
  // wire said the opposite. `reason` must stay pass-through: this endpoint's
  // reason taxonomy lives in `client.ts`, not here.
  | { kind: 'not-ready'; reason: AggkitNotReadyReason; detail: string }
  | { kind: 'unknown'; reason: string }; // no client for destination

export class AggkitBridgeAggregator {
  private readonly clients: Map<number, AggkitBridgeClient>;

  constructor(config: AggkitAggregatorConfig) {
    this.clients = new Map();
    for (const [key, baseUrl] of Object.entries(config.networks)) {
      const networkId = Number(key);
      this.clients.set(
        networkId,
        new AggkitBridgeClient({
          baseUrl,
          networkId,
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.retries !== undefined ? { retries: config.retries } : {}),
          ...(config.retryDelay !== undefined
            ? { retryDelay: config.retryDelay }
            : {}),
        })
      );
    }
  }

  /** Returns the single-network client for `networkId`; throws if unconfigured. */
  clientFor(networkId: number): AggkitBridgeClient {
    const client = this.clients.get(networkId);
    if (!client) {
      throw new Error(
        `AggkitBridgeAggregator: no client configured for network ${networkId}. ` +
          `Configured networks: ${this.listNetworkIds().join(', ') || '(none)'}`
      );
    }
    return client;
  }

  /**
   * Like `clientFor`, but routes L1 (`networkId === 0`) through a configured
   * L2 instance — L1 has no dedicated aggkit instance; every configured L2
   * instance's embedded L1 syncer serves `network_id=0` queries identically.
   * Mirrors the recording-network routing `getClaimInputs` applies via
   * `clientForRecordingNetwork` (which prefers the destination L2's instance
   * when the recording network is L1), generalized for callers (like
   * `getTokenMetadata`) that only have a bare `networkId` and no destination
   * to prefer.
   */
  private clientForNetworkOrL1(networkId: number): AggkitBridgeClient {
    if (networkId !== 0) {
      return this.clientFor(networkId);
    }
    const [firstConfigured] = this.listNetworkIds();
    if (firstConfigured === undefined) {
      throw new Error(
        `AggkitBridgeAggregator: no client configured for network 0. L1 has no ` +
          `dedicated instance and requires at least one configured L2 network to ` +
          `route through. Configured networks: (none)`
      );
    }
    return this.clientFor(firstConfigured);
  }

  /**
   * Picks the aggkit instance that can answer for `recordingNetworkId` — the
   * network whose local exit tree recorded the deposit (comment 3847422009).
   *
   * L1 (0) has no dedicated instance: every configured L2 instance's embedded
   * L1 syncer serves `network_id=0` identically, so prefer the destination
   * L2's instance (it is the one that must also answer the injected-GER probe)
   * and fall back to any configured instance — same rationale as
   * `clientForNetworkOrL1`.
   */
  private clientForRecordingNetwork(
    recordingNetworkId: number,
    destinationNetworkId: number
  ): AggkitBridgeClient {
    if (recordingNetworkId !== 0) {
      return this.clientFor(recordingNetworkId);
    }
    return (
      this.clients.get(destinationNetworkId) ?? this.clientForNetworkOrL1(0)
    );
  }

  listNetworkIds(): number[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Fan-out + join + status derivation. Never rejects if
   * at least one configured network's fan-out succeeds; rejects only if ALL
   * fan-outs fail (or no networks are configured).
   */
  async getActivity(params: {
    fromAddress: string;
    pageSize?: number;
    cursor?: string;
    order?: 'asc' | 'desc';
  }): Promise<AggkitActivityPage> {
    const pageSize = clampPageSize(params.pageSize);
    const order = params.order ?? 'desc';
    const cursorState = decodeCursor(params.cursor);
    const networkIds = this.listNetworkIds();

    // Doc/behavior parity (comment 3862897421): the JSDoc above promises a
    // rejection when no networks are configured -- previously the
    // `!anySucceeded && networkIds.length > 0` guard below was false in
    // this case (networkIds.length === 0), so `getActivity({ networks: {} })`
    // silently returned an empty page instead of rejecting.
    if (networkIds.length === 0) {
      throw new Error(
        'AggkitBridgeAggregator.getActivity: no networks configured'
      );
    }

    const settled = await Promise.allSettled(
      networkIds.map((networkId) =>
        this.fetchNetworkFanout(
          networkId,
          params.fromAddress,
          cursorState,
          pageSize
        )
      )
    );

    const failedNetworks: AggkitFailedNetwork[] = [];
    const claimsByNetwork = new Map<number, Map<string, AggkitClaim>>();
    const rows: FetchedBridgeRow[] = [];
    const nextCursor: AggkitPageCursor = { ...cursorState };
    let total = 0;
    let anySucceeded = false;

    settled.forEach((result, index) => {
      const networkId = networkIds[index] as number;

      if (result.status === 'rejected') {
        const error = result.reason;
        failedNetworks.push({
          networkId,
          error: errorMessage(error),
          ...(error instanceof AggkitApiError
            ? { httpStatus: error.httpStatus }
            : {}),
        });
        return;
      }

      anySucceeded = true;
      const fanout = result.value;

      for (const bridge of fanout.bridgeRowsA) {
        rows.push({
          bridge,
          sourceInstanceNetworkId: networkId,
          recordingNetworkId: networkId,
        });
      }
      for (const bridge of fanout.bridgeRowsB) {
        rows.push({
          bridge,
          sourceInstanceNetworkId: networkId,
          recordingNetworkId: 0,
        });
      }

      mergeClaimsMap(claimsByNetwork, networkId, fanout.claimsHere);
      mergeClaimsMap(claimsByNetwork, 0, fanout.claimsL1);

      total += fanout.totalBridgesCount;
      Object.assign(nextCursor, fanout.nextCursorPatch);
    });

    if (!anySucceeded && networkIds.length > 0) {
      throw new Error(
        `AggkitBridgeAggregator.getActivity: all configured networks failed: ` +
          failedNetworks.map((f) => `${f.networkId}: ${f.error}`).join('; ')
      );
    }

    // Dedupe by bridge_hash (unique per event).
    const dedupedByHash = new Map<string, FetchedBridgeRow>();
    for (const row of rows) {
      if (!dedupedByHash.has(row.bridge.bridge_hash)) {
        dedupedByHash.set(row.bridge.bridge_hash, row);
      }
    }
    const deduped = Array.from(dedupedByHash.values());

    deduped.sort((a, b) =>
      order === 'asc'
        ? a.bridge.block_timestamp - b.bridge.block_timestamp
        : b.bridge.block_timestamp - a.bridge.block_timestamp
    );

    // Per-row Tier-2 probe failures are collected separately from
    // fan-out failures so a failing destination/recording network degrades
    // this row to a conservative status instead of rejecting the whole call.
    const probeFailures: AggkitFailedNetwork[] = [];
    const onNetworkError = (failure: AggkitFailedNetwork): void => {
      probeFailures.push(failure);
    };

    const data = await Promise.all(
      deduped.map((row) =>
        this.toTransaction(
          row.bridge,
          row.sourceInstanceNetworkId,
          row.recordingNetworkId,
          claimsByNetwork,
          onNetworkError
        )
      )
    );

    // Merge probe failures into failedNetworks, deduped by networkId (keep
    // the first message — fan-out failures, collected above, take priority
    // over a later per-row probe failure for the same network).
    const seenFailedNetworkIds = new Set(
      failedNetworks.map((f) => f.networkId)
    );
    for (const failure of probeFailures) {
      if (!seenFailedNetworkIds.has(failure.networkId)) {
        seenFailedNetworkIds.add(failure.networkId);
        failedNetworks.push(failure);
      }
    }

    const anyMore = Object.values(nextCursor).some((v) => v !== EXHAUSTED);

    return {
      data,
      pagination: {
        total,
        limit: pageSize,
        ...(anyMore
          ? { nextStartAfterCursor: JSON.stringify(nextCursor) }
          : {}),
      },
      failedNetworks,
    };
  }

  /**
   * Cheap ready-to-claim count: one bounded (single, large)
   * page of bridges+claims per configured network (Tier 1) to build the
   * unclaimed set, then Tier-2 `/l1-info-tree-index` probes bounded to that
   * unclaimed set only — never a full activity scan.
   */
  async getReadyToClaimCount(params: { fromAddress: string }): Promise<number> {
    const networkIds = this.listNetworkIds();
    const pageSize = MAX_PAGE_SIZE;

    const settled = await Promise.allSettled(
      networkIds.map((networkId) =>
        this.fetchNetworkFanout(networkId, params.fromAddress, {}, pageSize)
      )
    );

    const claimsByNetwork = new Map<number, Map<string, AggkitClaim>>();
    const allRows: FetchedBridgeRow[] = [];
    let anySucceeded = false;

    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        return;
      }
      anySucceeded = true;
      const networkId = networkIds[index] as number;
      const fanout = result.value;

      mergeClaimsMap(claimsByNetwork, networkId, fanout.claimsHere);
      mergeClaimsMap(claimsByNetwork, 0, fanout.claimsL1);

      for (const bridge of fanout.bridgeRowsA) {
        allRows.push({
          bridge,
          sourceInstanceNetworkId: networkId,
          recordingNetworkId: networkId,
        });
      }
      for (const bridge of fanout.bridgeRowsB) {
        allRows.push({
          bridge,
          sourceInstanceNetworkId: networkId,
          recordingNetworkId: 0,
        });
      }
    });

    if (!anySucceeded && networkIds.length > 0) {
      throw new Error(
        'AggkitBridgeAggregator.getReadyToClaimCount: all configured networks failed'
      );
    }

    const seenHashes = new Set<string>();
    const unclaimed = allRows.filter((row) => {
      if (seenHashes.has(row.bridge.bridge_hash)) {
        return false;
      }
      seenHashes.add(row.bridge.bridge_hash);

      const claims = claimsByNetwork.get(row.bridge.destination_network);
      return !claims?.has(row.bridge.global_index);
    });

    const readyFlags = await Promise.all(
      unclaimed.map(async (row) => {
        // Guard the whole per-row probe: a failing
        // network's probe must under-count the badge, not reject the whole
        // count call. `useReadyToClaimCount` has no `failedNetworks` surface
        // by design (`app/hooks/useReadyToClaimCount.ts`).
        try {
          const probe = await this.clientFor(
            row.sourceInstanceNetworkId
          ).getL1InfoTreeIndex({
            networkId: row.recordingNetworkId,
            depositCount: row.bridge.deposit_count,
          });

          // Narrow on `ready`, never on the numeric value: L1-info-tree
          // leaf index 0 is valid and falsy.
          if (!probe.ready) {
            return false;
          }

          // Tier-1 membership only checked page 1 of /claims — bounded, cheap,
          // and wrong once a network's total claims exceed one page (bug b,
          // see the claims-pagination correctness regression test).
          // For candidates that passed the leaf-included probe (i.e. that
          // would otherwise be counted READY_TO_CLAIM), confirm with a
          // targeted per-candidate query before counting them.
          const confirmedClaim = await this.confirmClaimed(
            row.bridge,
            row.sourceInstanceNetworkId
          );
          return confirmedClaim === null;
        } catch {
          return false;
        }
      })
    );

    return readyFlags.filter(Boolean).length;
  }

  /**
   * Targeted confirmation backstop for bug (b): page-1 `/claims` membership
   * (Tier 1, cheap fast path) can miss a deposit's claim once a network's
   * total claim count exceeds one page, mis-deriving already-CLAIMED
   * deposits as READY_TO_CLAIM. `/claims[].from_address` is always "" in
   * aggkit responses so claims cannot be filtered by address — but
   * `/claims?global_index=<gi>` returns the exact matching claim if one
   * exists, regardless of which page it would have landed on. This is only
   * called for candidates that already passed the Tier-2 leaf-included probe
   * (i.e. would otherwise be marked READY_TO_CLAIM), so the extra request
   * count per page is bounded to that small candidate set, not the whole
   * claims tree.
   */
  private async confirmClaimed(
    bridge: AggkitBridge,
    sourceInstanceNetworkId: number
  ): Promise<AggkitClaim | null> {
    const destinationNetworkId = bridge.destination_network;
    // Claims recorded on L1 (destination 0) are visible via any configured
    // instance's own embedded L1 syncer — use the instance
    // this row was already fetched through. Claims recorded on a configured
    // L2 network must be queried via that network's own instance (aggkit
    // rejects `network_id`s it doesn't serve).
    const client =
      destinationNetworkId === 0
        ? this.clientFor(sourceInstanceNetworkId)
        : this.clients.get(destinationNetworkId);

    if (!client) {
      // No configured instance can confirm this destination network's
      // claims (e.g. an unconfigured L2->L2 destination).
      // Not more precise than the Tier-1/Tier-2 result already computed.
      return null;
    }

    try {
      const result = await client.getClaims({
        networkId: destinationNetworkId,
        globalIndex: bridge.global_index,
      });
      const claim = result.claims[0];
      // Verify the returned claim actually matches the requested
      // global_index (comment 3847451952): if a proxy ever drops the
      // `global_index` filter param, aggkit could return an unrelated
      // claim, which would otherwise be reported as this bridge's claim --
      // showing a stranger's claim tx as the user's and undercounting the
      // ready-to-claim badge.
      if (
        !claim ||
        !globalIndexesMatch(claim.global_index, bridge.global_index)
      ) {
        return null;
      }
      return claim;
    } catch {
      // The confirmation query is a correctness backstop, not a hard
      // dependency — if it fails, fall back to the Tier-2 probe result
      // rather than failing the whole activity/count call.
      return null;
    }
  }

  /**
   * Resolves the L1-info-tree index that `/claim-proof` must be built against for a
   * deposit landing on `destinationNetworkId`.
   *  - destinationNetworkId === 0  -> { resolved, sourceL1InfoTreeIndex } (no injection step)
   *  - destination client missing  -> { unknown } (caller keeps legacy behaviour)
   *  - 404 "not injected"          -> { not-injected, detail }
   *  - 200                         -> { resolved, leaf.l1_info_tree_index }  // >= source index
   * Probe errors are NOT swallowed here; they propagate so callers can attribute them
   * to `failedNetworks`.
   */
  private async resolveInjectedLeafIndex(params: {
    destinationNetworkId: number;
    sourceL1InfoTreeIndex: number;
  }): Promise<InjectedLeafResolution> {
    const { destinationNetworkId, sourceL1InfoTreeIndex } = params;

    // L1 has no injection step — the handler returns the leaf AT the index
    // for network_id=0.
    if (destinationNetworkId === 0) {
      return { kind: 'resolved', leafIndex: sourceL1InfoTreeIndex };
    }

    const client = this.clients.get(destinationNetworkId);
    if (!client) {
      // Mirrors the existing confirmClaimed fallback: an
      // unconfigured destination L2 keeps today's (possibly reverting)
      // behaviour rather than regressing into a permanent non-actionable
      // state. The on-chain revert remains the backstop.
      return {
        kind: 'unknown',
        reason: `no client configured for destination network ${destinationNetworkId}`,
      };
    }

    const probe = await client.getInjectedL1InfoLeaf({
      networkId: destinationNetworkId,
      leafIndex: sourceL1InfoTreeIndex,
    });

    if (!probe.ready) {
      return {
        kind: 'not-ready',
        reason: probe.reason,
        detail: probe.detail,
      };
    }
    const leaf = probe.value;

    // Contract check (comment 3862897612): `getInjectedL1InfoLeaf`'s own
    // doc promises `result.l1_info_tree_index >= leafIndex` for an L2
    // destination -- nothing previously asserted it here. If aggkit ever
    // returns a LOWER leaf, a proof built against it doesn't cover this
    // deposit and reverts `GlobalExitRootInvalid` on-chain with zero
    // diagnostic. Fail fast with both indices named instead.
    if (leaf.l1_info_tree_index < sourceL1InfoTreeIndex) {
      throw new Error(
        `AggkitBridgeAggregator.resolveInjectedLeafIndex: destination network ` +
          `${destinationNetworkId} returned injected L1-info-tree leaf index ` +
          `${leaf.l1_info_tree_index}, which is LOWER than the deposit's own ` +
          `source L1-info-tree index ${sourceL1InfoTreeIndex}. This violates ` +
          `aggkit's documented contract (result.l1_info_tree_index >= leafIndex ` +
          `for an L2 destination) -- a proof built against leaf ` +
          `${leaf.l1_info_tree_index} would not cover this deposit and would ` +
          `revert GlobalExitRootInvalid on-chain.`
      );
    }

    return { kind: 'resolved', leafIndex: leaf.l1_info_tree_index };
  }

  /**
   * Single-tx claim inputs.
   *
   * Resolves, in order: the deposit's own L1-info-tree index on the RECORDING
   * network (the network whose local exit tree holds the leaf — see
   * `recordingNetworkId`), then — for an L2 destination only — that
   * destination's INJECTED leaf index at-or-after it, then the claim proof
   * against the injected index.
   *
   * "Not yet claimable" is DATA, NOT AN ERROR: this method returns
   * `{ claimable: false, reason, detail }` for a valid request whose deposit
   * simply is not claimable yet (source not settled to the L1 info tree, or
   * the destination has not injected the GER). It throws only for genuine
   * failures — `AggkitApiError` for a real non-2xx response, a plain `Error`
   * for a backend-contract violation or a configuration problem, OR a plain
   * `Error` (with `.cause` set to the underlying network error) for a
   * transport failure after retries are exhausted — a transport failure does
   * NOT produce `AggkitApiError` (`httpRaw.ts`'s `fetchRawText` throws before
   * any response ever reaches the code that constructs one; see audit
   * finding C4) (comments 3847523270 / 3847600104).
   *
   * `reason` is an OPEN union (`AggkitNotReadyReason`): branch with a
   * `default` that keeps polling, never with an exhaustive `assertNever`.
   *
   * ROUTING (comment 3847422009): every tree-relative argument is keyed by
   * `recordingNetworkId`, never by the asset's `origin_network`. Passing the
   * origin network builds a proof from a DIFFERENT network's exit tree at the
   * same `deposit_count` — a well-formed proof for an unrelated deposit, with
   * no error raised anywhere. `destinationNetworkId` is used ONLY for the
   * injected-GER gate.
   */
  async getClaimInputs(
    params: AggkitClaimInputsParams
  ): Promise<AggkitClaimInputsResult> {
    // `originNetworkId?: never` only protects TypeScript callers; a JS caller
    // passing the removed parameter would otherwise silently get a proof from
    // the wrong tree (comment 3847422009).
    if (
      'originNetworkId' in params &&
      (params as unknown as Record<string, unknown>)['originNetworkId'] !==
        undefined
    ) {
      throw new Error(
        `AggkitBridgeAggregator.getClaimInputs: 'originNetworkId' was removed and ` +
          `replaced by 'recordingNetworkId' — the network whose local exit tree ` +
          `RECORDED the deposit, not the asset's origin network. Passing the origin ` +
          `network builds a proof from the wrong tree (comment 3847422009). Use ` +
          `AggkitTransaction.sourceNetwork.`
      );
    }

    const { recordingNetworkId, destinationNetworkId, depositCount } = params;

    const client = this.clientForRecordingNetwork(
      recordingNetworkId,
      destinationNetworkId
    );

    const sourceProbe = await client.getL1InfoTreeIndex({
      networkId: recordingNetworkId,
      depositCount,
    });

    if (!sourceProbe.ready) {
      // The source side simply is not settled yet. A valid request with a
      // "not yet" answer is data, not an error — the fabricated
      // `AggkitApiError(httpStatus: 500)` this used to throw claimed an
      // internal server error for a successful response
      // (comment 3847523270).
      return {
        claimable: false,
        reason: sourceProbe.reason,
        detail: sourceProbe.detail,
      };
    }
    const sourceL1InfoTreeIndex = sourceProbe.value;

    const resolution = await this.resolveInjectedLeafIndex({
      destinationNetworkId,
      sourceL1InfoTreeIndex,
    });

    let leafIndex: number;
    if (resolution.kind === 'not-ready') {
      // Source is settled, the destination side is not ready yet — again data,
      // not the fabricated `AggkitApiError(httpStatus: 404)` this used to
      // throw. `sourceL1InfoTreeIndex` carries the diagnostic that used to be
      // embedded in that error's prose.
      //
      // `resolution.reason` is passed through, NOT hard-coded: rc6+ answers
      // this endpoint with `L1_INFO_LEAF_NOT_INDEXED` and `SYNCER_INCONSISTENT`
      // as well as `DESTINATION_GER_NOT_INJECTED`, and on the first of those
      // the GER *is* already injected (audit finding C2).
      return {
        claimable: false,
        reason: resolution.reason,
        detail: resolution.detail,
        sourceL1InfoTreeIndex,
      };
    } else if (resolution.kind === 'unknown') {
      // Legacy behaviour, unchanged: an unconfigured destination cannot be
      // gated, so proceed on the source index with the on-chain revert as the
      // backstop. Deliberately `claimable: true` — folding it into a
      // not-ready reason would make unconfigured-destination claims
      // permanently non-actionable. `toTransaction` derives READY_TO_CLAIM
      // for the same case; the two must stay consistent.
      leafIndex = sourceL1InfoTreeIndex;
    } else {
      leafIndex = resolution.leafIndex;
    }

    const proofResult = await client.getClaimProof({
      networkId: recordingNetworkId,
      leafIndex,
      depositCount,
    });

    if (!proofResult.ready) {
      return {
        claimable: false,
        reason: proofResult.reason,
        detail: proofResult.detail,
        sourceL1InfoTreeIndex,
      };
    }

    return {
      claimable: true,
      leafIndex,
      proof: proofResult.value,
      sourceL1InfoTreeIndex,
    };
  }

  /**
   * Token metadata composition: native check, then
   * token-mappings resolution (best-effort) + on-chain `ERC20.getMetadata()`
   * reads. Output shape matches the UI's existing `TokenMetadata` contract.
   */
  async getTokenMetadata(
    tokenAddress: string,
    networkId: number
  ): Promise<AggkitTokenMetadata> {
    // L1 (networkId 0) has no dedicated aggkit instance — route through a
    // configured L2 instance, same as `getClaimInputs`.
    const client = this.clientForNetworkOrL1(networkId);
    // FIXED: `getChainByNetworkId` previously returned the
    // first insertion-order match, and Ethereum mainnet is pre-seeded at
    // networkId 0 ahead of any other networkId-0 chain (e.g. a devnet L1).
    // For NATIVE token metadata on networkId 0 this reported mainnet's
    // nativeCurrency/rpcUrl instead of the intended chain. `ChainRegistry`
    // now tracks which chainIds are built-in defaults and, on a networkId
    // collision, always prefers a consumer-registered chain over a default
    // one — independent of registration order (see
    // `src/native/chains/registry.ts`'s `getChainByNetworkId` precedence
    // note). Consumers that register their L1 (e.g. devnet, networkId 0) no
    // longer risk resolving the SDK's default mainnet entry.
    const chain = chainRegistry.getChainByNetworkId(networkId);

    if (isNativeTokenAddress(tokenAddress)) {
      return {
        name: chain.nativeCurrency.name,
        symbol: chain.nativeCurrency.symbol,
        decimals: chain.nativeCurrency.decimals,
        tokenAddress: ZERO_ADDRESS,
        network: networkId,
      };
    }

    const mappingsResult = await client.getTokenMappings({
      networkId,
      originTokenAddress: tokenAddress,
    });
    const mapping = mappingsResult.token_mappings[0];

    const erc20 = new ERC20({
      tokenAddress,
      rpcUrl: chain.rpcUrl,
      chainId: chain.chainId,
    });
    const onChain = await erc20.getMetadata();

    return {
      name: onChain.name,
      symbol: onChain.symbol,
      decimals: onChain.decimals,
      tokenAddress,
      network: networkId,
      ...(onChain.totalSupply !== undefined
        ? { totalSupply: onChain.totalSupply }
        : {}),
      ...(mapping
        ? {
            originTokenAddress: mapping.origin_token_address,
            originTokenNetwork: mapping.origin_network,
            wrappedTokenAddressV1: mapping.wrapped_token_address,
          }
        : {}),
    };
  }

  /**
   * Bridge tracker lookup (aggkit `tracker/v1`,
   * `docs/bridgetracker/API.md`): registers (if not already) and returns
   * `txHash`'s `AggkitTrackingData` from the aggkit instance serving
   * `networkId`. Routes L1 (`networkId === 0`) through a configured L2
   * instance, same as `getTokenMetadata` — L1 has no dedicated instance —
   * and always passes `networkId` through explicitly to
   * `AggkitBridgeClient.getBridgeTracking`'s URL path, since the routed-
   * through L2 instance's own `networkId` is not 0.
   *
   * See `AggkitBridgeClient.getBridgeTracking` for terminal-state/polling
   * guidance, and the `AggkitTrackingData`/`AggkitBridgeStepPath` etc. type
   * docs in `types.ts` for the full wire-format reference —
   * `tracking_status`/`bridge_type`/`step_name`/step `status` are bare
   * string unions on the wire, not numeric + `_string` companion pairs,
   * matching aggkit's rc5-corrected `API.md` (agglayer/aggkit#1781, fixed
   * in PR #1784); the wire format itself has been unchanged since rc4.
   */
  async getBridgeTracking(
    networkId: number,
    txHash: string
  ): Promise<AggkitTrackingData> {
    const client = this.clientForNetworkOrL1(networkId);
    return client.getBridgeTracking(txHash, networkId);
  }

  /** Runs the four fan-out calls (A-D) for a single configured network. */
  private async fetchNetworkFanout(
    networkId: number,
    fromAddress: string,
    cursorState: AggkitPageCursor,
    pageSize: number
  ): Promise<NetworkFanoutResult> {
    const client = this.clientFor(networkId);

    const keyA = `${networkId}:bridgesOrigin`;
    const keyB = `${networkId}:bridgesL1`;
    const keyC = `${networkId}:claimsHere`;
    const keyD = `${networkId}:claimsL1`;

    const [a, b, c, d] = await Promise.all([
      // A. L2-origin bridges (n -> L1, n -> other L2).
      runPaginatedCall(cursorState, keyA, pageSize, (pageNumber) =>
        client
          .getBridges({
            networkId,
            fromAddress,
            pageNumber,
            pageSize,
          })
          .then((r) => ({ items: r.bridges, count: r.count }))
      ),
      // B. L1-origin bridges destined to n.
      runPaginatedCall(cursorState, keyB, pageSize, (pageNumber) =>
        client
          .getBridges({
            networkId: 0,
            networkIds: [networkId],
            fromAddress,
            pageNumber,
            pageSize,
          })
          .then((r) => ({ items: r.bridges, count: r.count }))
      ),
      // C. Claims on n (settles L1->n and other->n).
      runPaginatedCall(cursorState, keyC, pageSize, (pageNumber) =>
        client
          .getClaims({ networkId, pageNumber, pageSize })
          .then((r) => ({ items: r.claims, count: r.count }))
      ),
      // D. Claims on L1, as recorded via n's own L1 syncer (settles n->L1).
      runPaginatedCall(cursorState, keyD, pageSize, (pageNumber) =>
        client
          .getClaims({ networkId: 0, pageNumber, pageSize })
          .then((r) => ({ items: r.claims, count: r.count }))
      ),
    ]);

    const claimsHere = new Map<string, AggkitClaim>();
    for (const claim of c.items) {
      claimsHere.set(claim.global_index, claim);
    }

    const claimsL1 = new Map<string, AggkitClaim>();
    for (const claim of d.items) {
      claimsL1.set(claim.global_index, claim);
    }

    return {
      networkId,
      bridgeRowsA: a.items,
      bridgeRowsB: b.items,
      claimsHere,
      claimsL1,
      totalBridgesCount: a.count + b.count,
      nextCursorPatch: {
        [keyA]: a.nextPage ?? EXHAUSTED,
        [keyB]: b.nextPage ?? EXHAUSTED,
        [keyC]: c.nextPage ?? EXHAUSTED,
        [keyD]: d.nextPage ?? EXHAUSTED,
      },
    };
  }

  /**
   * Joins one bridge row into a UI `Transaction`, deriving `status`: Tier 1
   * (claims-set membership, free/batch) first, then Tier 2a (`/l1-info-tree-index`
   * probe, bounded to unclaimed rows only), then — for an L2 destination
   * only — Tier 2b (the destination-injected-GER gate).
   *
   * The Tier-2a probe is keyed by `recordingNetworkId` — the network whose
   * local exit tree actually recorded this deposit (call A vs call B of
   * `fetchNetworkFanout`, see `FetchedBridgeRow`) — NOT `bridge.origin_network`.
   * These coincide for genuine L1-origin deposits and genuine L2-origin
   * tokens, but diverge for withdrawals of an L2's native gas token,
   * where `origin_network` is always 0 but the deposit is
   * recorded on the L2's own tree.
   *
   * Both Tier-2 probes are guarded: a throw is
   * reported to `onNetworkError` and the row derives a conservative,
   * non-actionable status (`BRIDGED` for a Tier-2a failure, `LEAF_INCLUDED`
   * for a Tier-2b failure) instead of rejecting the whole `getActivity` call.
   */
  private async toTransaction(
    bridge: AggkitBridge,
    sourceInstanceNetworkId: number,
    recordingNetworkId: number,
    claimsByNetwork: Map<number, Map<string, AggkitClaim>>,
    onNetworkError: (failure: AggkitFailedNetwork) => void
  ): Promise<AggkitTransaction> {
    const destinationClaims = claimsByNetwork.get(bridge.destination_network);
    let matchedClaim = destinationClaims?.get(bridge.global_index);

    let status: AggkitTransactionStatus;
    let leafIndexForProof: number | undefined;

    if (matchedClaim) {
      status = 'CLAIMED';
    } else {
      const client = this.clientFor(sourceInstanceNetworkId);
      // `undefined` covers BOTH "aggkit says not yet" and "the probe threw",
      // as the previous `number | null` did — both derive BRIDGED. Only the
      // throw path reports a `failedNetworks` entry: a not-ready answer is a
      // healthy network saying "not yet", and attributing it as a failure
      // would make every in-flight deposit look like a network error.
      let sourceIndex: number | undefined;
      try {
        const probe = await client.getL1InfoTreeIndex({
          networkId: recordingNetworkId,
          depositCount: bridge.deposit_count,
        });
        if (probe.ready) {
          sourceIndex = probe.value;
        }
      } catch (error) {
        // Tier-2a throw: conservative non-actionable status, attribute the
        // failure to the recording network.
        onNetworkError(toFailedNetwork(recordingNetworkId, error));
      }

      // Narrow on `undefined`, never on truthiness: L1-info-tree index 0 is
      // a valid settled index.
      if (sourceIndex !== undefined) {
        // Tier-1 membership only covers page 1 of /claims (bounded, cheap
        // fast path) and can miss this deposit's claim once a network's
        // total claims exceed one page — mis-deriving READY_TO_CLAIM for an
        // already-CLAIMED deposit (bug b). Confirm with a targeted
        // global_index query before committing to READY_TO_CLAIM.
        const confirmedClaim = await this.confirmClaimed(
          bridge,
          sourceInstanceNetworkId
        );
        if (confirmedClaim) {
          matchedClaim = confirmedClaim;
          status = 'CLAIMED';
        } else if (bridge.destination_network === 0) {
          // L2->L1: no injection step (the destination-injected-GER gate
          // applies only to L2 destinations).
          status = 'READY_TO_CLAIM';
          leafIndexForProof = sourceIndex;
        } else {
          try {
            const resolution = await this.resolveInjectedLeafIndex({
              destinationNetworkId: bridge.destination_network,
              sourceL1InfoTreeIndex: sourceIndex,
            });

            if (resolution.kind === 'not-ready') {
              // Every destination-side not-ready reason derives the same
              // status: the source is settled but the destination gate has not
              // passed, so the row is not actionable yet. Unchanged behaviour —
              // only the arm's name and payload widened (audit finding C2).
              status = 'LEAF_INCLUDED';
            } else if (resolution.kind === 'unknown') {
              status = 'READY_TO_CLAIM';
              leafIndexForProof = sourceIndex;
            } else {
              status = 'READY_TO_CLAIM';
              leafIndexForProof = resolution.leafIndex;
            }
          } catch (error) {
            // Tier-2b throw: conservative non-actionable status, attribute
            // the failure to the destination network.
            onNetworkError(toFailedNetwork(bridge.destination_network, error));
            status = 'LEAF_INCLUDED';
          }
        }
      } else {
        status = 'BRIDGED';
      }
    }

    return {
      hubUID: bridge.bridge_hash,
      txSender: bridge.txn_sender,
      fromAddress: bridge.from_address || bridge.txn_sender,
      receiverAddress: bridge.destination_address,
      // Display counterpart of the recording-network status-derivation fix:
      // use the RECORDING network, not `bridge.origin_network`. For
      // an L2-native-gas-token withdrawal `origin_network` is always 0 (the
      // asset origin, L1 ETH) even though the row is recorded on the L2's
      // own local exit tree — `recordingNetworkId` already captures this
      // distinction (call A vs call B of `fetchNetworkFanout`).
      sourceNetwork: recordingNetworkId,
      destinationNetwork: bridge.destination_network,
      amount: bridge.amount,
      status,
      lastUpdatedAt: bridge.block_timestamp,
      bridgeHash: bridge.bridge_hash,
      metadata: bridge.metadata,
      leafType: String(bridge.leaf_type),
      depositCount: bridge.deposit_count,
      transactionIndex: bridge.block_pos,
      transactionHash: bridge.tx_hash,
      blockNumber: bridge.block_num,
      globalIndex: bridge.global_index,
      originTokenAddress: bridge.origin_address,
      originTokenNetwork: bridge.origin_network,
      timestamp: bridge.block_timestamp,
      leafIndex: bridge.deposit_count,
      ...(leafIndexForProof !== undefined ? { leafIndexForProof } : {}),
      ...(matchedClaim
        ? {
            claimTransactionHash: matchedClaim.tx_hash,
            claimTimestamp: matchedClaim.block_timestamp,
            claimBlockNumber: matchedClaim.block_num,
          }
        : {}),
    };
  }
}
