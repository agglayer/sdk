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
  AggkitReadyToClaimCountResult,
  AggkitTokenMetadata,
  AggkitTrackingData,
  AggkitTransaction,
  AggkitTransactionStatus,
} from './types';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/**
 * Modest cap on concurrent per-row claim-readiness probes against ONE
 * aggkit instance (issue #30 scope item 3, comment 3862897115): unbounded
 * concurrency here could put ~1,600 requests in flight for a single
 * `getReadyToClaimCount()` call at `MAX_PAGE_SIZE` (rows x probes x
 * retries), and a struggling instance's rate-limited/reset responses would
 * previously convert into "not ready" completely silently. Applied via
 * `mapWithConcurrencyLimit` to both `getActivity`'s per-row status
 * derivation and `getReadyToClaimCount`'s per-row predicate.
 */
const READY_PROBE_CONCURRENCY = 10;

function clampPageSize(pageSize: number | undefined): number {
  const size = pageSize ?? DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

/**
 * Runs `fn` over `items` allowing at most `limit` concurrent in-flight
 * calls, preserving output order (`results[i]` corresponds to `items[i]`
 * regardless of completion order). A small work-stealing pool: `limit`
 * workers each pull the next unclaimed index until none remain, rather than
 * chunking `items` into fixed-size batches (a batch would leave the pool
 * idle while a single slow request in that batch finishes before starting
 * the next batch).
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i] as T, i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Accepts ONLY a value that is unambiguously a non-negative safe integer:
 * either a `number` that is itself `Number.isSafeInteger` and `>= 0`, or a
 * non-empty digits-only `string` (`/^\d+$/` -- no sign, no decimal point,
 * no exponent, no surrounding whitespace, no radix prefix) whose numeric
 * value is a safe non-negative integer. Both branches enforce the same
 * `Number.isSafeInteger` bound so a numeric literal outside it (e.g. `1e21`,
 * or `9007199254740993` silently rounding to `9007199254740992`) is rejected
 * exactly like the equivalent string would be -- otherwise it would reach
 * aggkit as `page_number=1e%2B21` and 400 the whole fan-out for that network
 * (audit finding C5). A blanket `Number(value)` coercion
 * is deliberately NOT used here: `Number(null)`, `Number("")`,
 * `Number([])`, and `Number(false)` all evaluate to `0`, and `Number(true)`
 * evaluates to `1` -- silently accepting those as legitimate cursor state
 * instead of rejecting them as junk.
 */
function isSafeNonNegativeInteger(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const num = Number(value);
    return Number.isSafeInteger(num) && num >= 0;
  }
  return false;
}

function coerceSafeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Validates one decoded cursor entry against `AggkitSourceCursorState`'s
 * exact shape: `page`/`offset` must each independently pass
 * `isSafeNonNegativeInteger`, an `exhausted` key (if present at all) must be
 * a genuine `boolean`, and no OTHER key may be present — an object carrying
 * an extra unrecognized key is rejected wholesale rather than silently
 * stripped, matching the same junk-is-junk posture as the page-number
 * validation above (comment 3862897288).
 */
function isValidSourceCursorState(
  value: unknown
): value is { page: unknown; offset: unknown; exhausted?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const allowedKeys = new Set(['page', 'offset', 'exhausted']);
  if (!Object.keys(obj).every((key) => allowedKeys.has(key))) {
    return false;
  }
  if (!isSafeNonNegativeInteger(obj['page'])) {
    return false;
  }
  if (!isSafeNonNegativeInteger(obj['offset'])) {
    return false;
  }
  if ('exhausted' in obj && typeof obj['exhausted'] !== 'boolean') {
    return false;
  }
  return true;
}

/**
 * Decodes a `nextStartAfterCursor` string into per-SOURCE high-water
 * pagination state (`AggkitSourceCursorState` — see `types.ts` for the full
 * redesign rationale, issue #30 scope item 1). Coerces every entry and
 * drops anything that isn't a well-formed `{ page, offset, exhausted? }`
 * object -- e.g. `{"1:bridgesOrigin": "abc"}` or
 * `{"1:bridgesOrigin": {"page": "abc", "offset": 0}}` would otherwise reach
 * aggkit as `page_number=abc`, 400ing that source's fan-out
 * (comment 3862897288, carried forward from the page-number-only design).
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
      if (!isValidSourceCursorState(value)) {
        continue;
      }
      result[key] = {
        page: coerceSafeNonNegativeInteger(value.page),
        offset: coerceSafeNonNegativeInteger(value.offset),
        ...(typeof value.exhausted === 'boolean'
          ? { exhausted: value.exhausted }
          : {}),
      };
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

/**
 * One of `getActivity`'s two real feed sources for a configured network
 * (issue #30 scope item 1: claims are enrichment, not a co-equal paginated
 * source — see `AggkitSourceCursorState`'s doc in `types.ts`). `key` is this
 * source's slot in the opaque `AggkitPageCursor`.
 */
interface ActivitySource {
  key: string;
  /** The configured network whose client instance answers this call. */
  networkId: number;
  /** The network whose local exit tree recorded rows from this source. */
  recordingNetworkId: number;
  fetchPage: (
    pageNumber: number
  ) => Promise<{ items: AggkitBridge[]; count: number }>;
}

/** Live merge state for one `ActivitySource`, across possibly several page fetches within one `getActivity` call. */
interface SourceMergeState {
  source: ActivitySource;
  /** The currently loaded page's items; unconsumed ones start at `offset`. */
  items: AggkitBridge[];
  offset: number;
  page: number;
  count: number;
  exhausted: boolean;
  /** Set once this source has thrown DURING this call — stop pulling from it. */
  failed?: { error: unknown };
}

function hasBufferedItem(state: SourceMergeState): boolean {
  return state.offset < state.items.length;
}

function peekBufferedItem(state: SourceMergeState): AggkitBridge {
  return state.items[state.offset] as AggkitBridge;
}

/**
 * Whether a source has nothing left to give after this fetch: every item of
 * the CURRENTLY loaded page has already been consumed (`offset >= itemsLength`
 * — true for an empty page too, `0 >= 0`) AND aggkit itself reports no
 * further page (`page * pageSize >= count`). Evaluated right after EVERY
 * fetch (initial or refill) — not deferred to a later "pop" step — because a
 * source whose very first fetched page comes back with ZERO items (already
 * fully consumed upstream, or simply has no matching rows at all) never gets
 * popped from at all, and would otherwise sit at its default `exhausted:
 * false` forever, wrongly keeping the OVERALL page reported as "more
 * available" with a cursor that just re-fetches the same empty page forever.
 */
function isSourcePageExhausted(
  offset: number,
  itemsLength: number,
  page: number,
  count: number,
  pageSize: number
): boolean {
  return offset >= itemsLength && page * pageSize >= count;
}

/**
 * Initializes one source's merge state from the incoming cursor: skip
 * entirely if already marked `exhausted`, otherwise fetch the stored (or
 * default first) page. A thrown fetch is caught HERE (not left to reject
 * the whole `Promise.all` in `mergeActivitySources`) so one source's
 * failure never prevents every other source's fetch from starting or
 * completing — the `Promise.allSettled`-style degrade issue #30 scope item
 * 2 asks for, generalized from "per network" to "per source".
 */
async function initSourceState(
  source: ActivitySource,
  cursorState: AggkitPageCursor,
  pageSize: number
): Promise<SourceMergeState> {
  const stored = cursorState[source.key];
  if (stored?.exhausted) {
    return {
      source,
      items: [],
      offset: 0,
      page: stored.page,
      count: 0,
      exhausted: true,
    };
  }

  const page = stored?.page ?? 1;
  const offset = stored?.offset ?? 0;
  try {
    const { items, count } = await source.fetchPage(page);
    return {
      source,
      items,
      offset,
      page,
      count,
      exhausted: isSourcePageExhausted(
        offset,
        items.length,
        page,
        count,
        pageSize
      ),
    };
  } catch (error) {
    return {
      source,
      items: [],
      offset,
      page,
      count: 0,
      exhausted: false,
      failed: { error },
    };
  }
}

/** Result of `mergeActivitySources`. */
interface MergeActivityResult {
  rows: FetchedBridgeRow[];
  /** This call's updated cursor — pass straight through as the next `getActivity({ cursor })`. */
  nextCursor: AggkitPageCursor;
  failedNetworks: AggkitFailedNetwork[];
  /** True iff every source across every configured network is now exhausted. */
  exhausted: boolean;
  /**
   * Keys of every source that did NOT throw this round — includes sources
   * that were already exhausted by a prior call (legitimately done, not a
   * failure). Used by `getActivity`'s all-networks-failed guard: a fully
   * paginated-through address (every source exhausted, zero new rows) must
   * NOT be confused with a genuine outage (every source erroring).
   */
  succeededSourceKeys: Set<string>;
}

/**
 * k-way merge across every configured network's two real feed sources
 * (bridges-by-origin / bridges-by-L1-destination), honoring aggkit's own
 * fixed newest-first per-source page order (confirmed against
 * `__fixtures__/bridges_page1.json`/`bridges_page2.json` — aggkit accepts no
 * sort/order query param, so every source's pages arrive in that one fixed
 * order regardless of `getActivity`'s `order`). Emits AT MOST `pageSize`
 * rows, by repeatedly taking whichever source's next buffered row is
 * currently newest and, once a source's buffered page is exhausted,
 * fetching that ONE source's next page to keep the merge going — never
 * concatenating whole pages from every source and slicing after the fact
 * (design comment 3862896800: that both over-returns, up to
 * `sources.length * pageSize` rows, and can't guarantee true cross-page
 * ordering).
 *
 * `getActivity`'s `order: 'asc'` is NOT implemented by walking sources
 * backward from their last page — aggkit's pagination has no sort param at
 * all, so true incremental ascending pagination would require locating and
 * consuming each source's LAST page first (needing its total page count
 * up front, itself unstable under concurrent inserts). That is out of
 * scope for this redesign (the review comments this issue tracks named
 * `desc`'s cross-page ordering specifically); `getActivity` instead reverses
 * this method's newest-first output as a COSMETIC, page-local
 * transformation, matching this SDK's pre-existing `asc` behavior exactly
 * (a full local sort of one page's rows) rather than delivering true
 * globally-ordered ascending pagination.
 *
 * A source that throws keeps its PRIOR cursor entry completely untouched —
 * `nextCursor` for a failed source is whatever was already in `cursorState`
 * (usually a proper subset of a fresh object, since a first-ever call has
 * no incoming entry either) — so the next call retries it from exactly
 * where it left off (comment 3862896964: previously a network failing on
 * page 1 contributed no cursor keys at all, with no way to retry short of a
 * full restart).
 */
async function mergeActivitySources(
  sources: ActivitySource[],
  cursorState: AggkitPageCursor,
  pageSize: number
): Promise<MergeActivityResult> {
  const states = await Promise.all(
    sources.map((source) => initSourceState(source, cursorState, pageSize))
  );

  const rows: FetchedBridgeRow[] = [];

  while (rows.length < pageSize) {
    // Tie-break: iteration order of `states` (deterministic — derived from
    // `listNetworkIds()`'s stable insertion order), not a meaningful
    // business rule. Ties only matter for reproducibility here.
    let best: SourceMergeState | undefined;
    for (const state of states) {
      if (!hasBufferedItem(state)) {
        continue;
      }
      if (
        !best ||
        peekBufferedItem(state).block_timestamp >
          peekBufferedItem(best).block_timestamp
      ) {
        best = state;
      }
    }
    if (!best) {
      break; // Nothing buffered anywhere this round.
    }

    const bridge = peekBufferedItem(best);
    rows.push({
      bridge,
      sourceInstanceNetworkId: best.source.networkId,
      recordingNetworkId: best.source.recordingNetworkId,
    });
    best.offset += 1;

    if (!hasBufferedItem(best) && !best.failed) {
      const hasMore = best.page * pageSize < best.count;
      if (!hasMore) {
        best.exhausted = true;
      } else {
        try {
          const { items, count } = await best.source.fetchPage(best.page + 1);
          best.page += 1;
          best.offset = 0;
          best.items = items;
          best.count = count;
          // Re-evaluate immediately (see `isSourcePageExhausted`'s doc): the
          // refilled page can itself be empty-with-no-further-pages.
          best.exhausted = isSourcePageExhausted(
            0,
            items.length,
            best.page,
            count,
            pageSize
          );
        } catch (error) {
          best.failed = { error };
        }
      }
    }
  }

  const failedNetworks: AggkitFailedNetwork[] = [];
  const nextCursor: AggkitPageCursor = { ...cursorState };
  const succeededSourceKeys = new Set<string>();
  let anyMore = false;

  for (const state of states) {
    if (state.failed) {
      failedNetworks.push(
        toFailedNetwork(state.source.networkId, state.failed.error)
      );
      if (!nextCursor[state.source.key]?.exhausted) {
        anyMore = true; // A failed, non-exhausted source still owes rows.
      }
      continue;
    }
    succeededSourceKeys.add(state.source.key);
    if (state.exhausted) {
      nextCursor[state.source.key] = {
        page: state.page,
        offset: state.offset,
        exhausted: true,
      };
    } else {
      nextCursor[state.source.key] = { page: state.page, offset: state.offset };
      anyMore = true;
    }
  }

  return {
    rows,
    nextCursor,
    failedNetworks,
    exhausted: !anyMore,
    succeededSourceKeys,
  };
}

/**
 * Fetches one bounded (page 1 only, size `pageSize`), unpaginated snapshot
 * of claims per network — the Tier-1 fast-path enrichment lookup that
 * decorates bridge rows with claim status (issue #30 scope item 1: claims
 * are NOT a co-equal paginated source; `confirmClaimed`'s targeted
 * `global_index` probe remains the actual authority for any row this misses
 * — see the "claims-pagination correctness" regression tests). Degrades
 * PER CALL (`Promise.allSettled`, issue #30 scope item 2, comment
 * 3847432202): a failing claims list no longer wipes this network's bridge
 * rows out of the fan-out the way a single `Promise.all` used to.
 */
async function fetchClaimsEnrichment(
  client: AggkitBridgeClient,
  networkId: number,
  pageSize: number
): Promise<{
  claimsHere: Map<string, AggkitClaim>;
  claimsL1: Map<string, AggkitClaim>;
  failedNetworks: AggkitFailedNetwork[];
}> {
  const [hereResult, l1Result] = await Promise.allSettled([
    client.getClaims({ networkId, pageNumber: 1, pageSize }),
    client.getClaims({ networkId: 0, pageNumber: 1, pageSize }),
  ]);

  const claimsHere = new Map<string, AggkitClaim>();
  const claimsL1 = new Map<string, AggkitClaim>();
  const failedNetworks: AggkitFailedNetwork[] = [];

  if (hereResult.status === 'fulfilled') {
    for (const claim of hereResult.value.claims) {
      claimsHere.set(claim.global_index, claim);
    }
  } else {
    failedNetworks.push(toFailedNetwork(networkId, hereResult.reason));
  }

  if (l1Result.status === 'fulfilled') {
    for (const claim of l1Result.value.claims) {
      claimsL1.set(claim.global_index, claim);
    }
  } else {
    failedNetworks.push(toFailedNetwork(networkId, l1Result.reason));
  }

  return { claimsHere, claimsL1, failedNetworks };
}

/**
 * Renders an error's message, appending its `.cause` chain (if any) so the
 * information the retry-exhaustion path in `httpRaw.ts` attaches via
 * `new Error(msg, { cause })` doesn't get dropped again here -- the one
 * remaining place inside the SDK that discarded it (audit finding C11,
 * closing the rest of comment 3862898418: the chain now survives all the way
 * to `AggkitFailedNetwork.error`, which is what dev-ui actually renders).
 * Walks more than one level in case a future wrapper nests causes.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const causes: string[] = [];
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    causes.push(cause.message);
    cause = cause.cause;
  }
  return causes.length > 0
    ? `${error.message} (cause: ${causes.join(' -> ')})`
    : error.message;
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
   * Fan-out + k-way merge + join + status derivation. Never rejects if at
   * least one configured network's feed sources succeed; rejects only if
   * EVERY configured network's feed sources fail (or no networks are
   * configured) — a network that is simply fully paginated through
   * (exhausted, contributing zero NEW rows) does not count as failed.
   *
   * REDESIGNED (issue #30): see `mergeActivitySources` for the k-way
   * merge/high-water-cursor mechanics (scope item 1) and
   * `fetchClaimsEnrichment` for why claims are no longer part of the
   * pagination contract at all. `pagination.total` is GONE (see
   * `AggkitActivityPage` in `types.ts`) and `AggkitPageCursor`'s shape
   * changed — see the breaking-changes note in the README. Every fan-out
   * call (both feed sources per network, both claims lists per network, and
   * each row's Tier-2 probes) now degrades independently
   * (`Promise.allSettled`, scope item 2) instead of one `Promise.all`
   * failure wiping an entire network's contribution.
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
    // rejection when no networks are configured.
    if (networkIds.length === 0) {
      throw new Error(
        'AggkitBridgeAggregator.getActivity: no networks configured'
      );
    }

    const sources: ActivitySource[] = networkIds.flatMap((networkId) => {
      const client = this.clientFor(networkId);
      return [
        {
          key: `${networkId}:bridgesOrigin`,
          networkId,
          recordingNetworkId: networkId,
          fetchPage: (pageNumber: number) =>
            client
              .getBridges({
                networkId,
                fromAddress: params.fromAddress,
                pageNumber,
                pageSize,
              })
              .then((r) => ({ items: r.bridges, count: r.count })),
        },
        {
          key: `${networkId}:bridgesL1`,
          networkId,
          recordingNetworkId: 0,
          fetchPage: (pageNumber: number) =>
            client
              .getBridges({
                networkId: 0,
                networkIds: [networkId],
                fromAddress: params.fromAddress,
                pageNumber,
                pageSize,
              })
              .then((r) => ({ items: r.bridges, count: r.count })),
        },
      ];
    });

    const merged = await mergeActivitySources(sources, cursorState, pageSize);

    const claimsResults = await Promise.all(
      networkIds.map((networkId) =>
        fetchClaimsEnrichment(this.clientFor(networkId), networkId, pageSize)
      )
    );
    const claimsByNetwork = new Map<number, Map<string, AggkitClaim>>();
    const claimsFailedNetworks: AggkitFailedNetwork[] = [];
    networkIds.forEach((networkId, index) => {
      const result = claimsResults[index] as (typeof claimsResults)[number];
      mergeClaimsMap(claimsByNetwork, networkId, result.claimsHere);
      mergeClaimsMap(claimsByNetwork, 0, result.claimsL1);
      claimsFailedNetworks.push(...result.failedNetworks);
    });

    // A network counts as "succeeded" for the all-failed guard iff at
    // least one of its two REAL feed sources didn't throw — a claims
    // failure alone contributes zero rows either way, so it must not save
    // (or sink) this guard.
    const anyNetworkSucceeded = networkIds.some(
      (networkId) =>
        merged.succeededSourceKeys.has(`${networkId}:bridgesOrigin`) ||
        merged.succeededSourceKeys.has(`${networkId}:bridgesL1`)
    );
    if (!anyNetworkSucceeded) {
      throw new Error(
        `AggkitBridgeAggregator.getActivity: all configured networks failed: ` +
          merged.failedNetworks
            .map((f) => `${f.networkId}: ${f.error}`)
            .join('; ')
      );
    }

    // Defensive dedupe by bridge_hash (unique per event): the merge's
    // sources are structurally disjoint per network, but this stays as a
    // safety net against any edge-case overlap, same as before.
    const dedupedByHash = new Map<string, FetchedBridgeRow>();
    for (const row of merged.rows) {
      if (!dedupedByHash.has(row.bridge.bridge_hash)) {
        dedupedByHash.set(row.bridge.bridge_hash, row);
      }
    }
    // `mergeActivitySources` always walks aggkit's native newest-first
    // per-source page order (see its JSDoc for why `asc` can't be a true
    // backward-from-last-page traversal); `asc` here is a COSMETIC reversal
    // of this page's own rows, matching this SDK's pre-existing `asc`
    // behavior (a full local sort of one page) rather than delivering true
    // globally-ordered ascending pagination.
    const orderedRows = Array.from(dedupedByHash.values());
    if (order === 'asc') {
      orderedRows.reverse();
    }

    // Per-row Tier-2 probe failures are collected separately from fan-out
    // failures so a failing destination/recording network degrades this
    // row to a conservative status instead of rejecting the whole call.
    const probeFailures: AggkitFailedNetwork[] = [];
    const onNetworkError = (failure: AggkitFailedNetwork): void => {
      probeFailures.push(failure);
    };

    const data = await mapWithConcurrencyLimit(
      orderedRows,
      READY_PROBE_CONCURRENCY,
      (row) =>
        this.toTransaction(
          row.bridge,
          row.sourceInstanceNetworkId,
          row.recordingNetworkId,
          claimsByNetwork,
          onNetworkError
        )
    );

    const fanOutFailedNetworks = [
      ...merged.failedNetworks,
      ...claimsFailedNetworks,
    ];

    // Per-row Tier-2 probes are deduped by networkId (first-wins) BEFORE
    // merging into the fan-out-level failures above — unlike the fan-out
    // calls (bounded to at most 4 per network), a single failing endpoint
    // can affect every row on a page, and reporting one entry per AFFECTED
    // ROW rather than per DISTINCT FAILING CALL would balloon
    // `failedNetworks` to page-size length instead of network-count length.
    // A fan-out-level failure for the same network takes priority (it is
    // usually the root cause a later per-row probe failure for that network
    // is redundant with).
    const seenFailedNetworkIds = new Set(
      fanOutFailedNetworks.map((f) => f.networkId)
    );
    const dedupedProbeFailures: AggkitFailedNetwork[] = [];
    for (const failure of probeFailures) {
      if (!seenFailedNetworkIds.has(failure.networkId)) {
        seenFailedNetworkIds.add(failure.networkId);
        dedupedProbeFailures.push(failure);
      }
    }

    const failedNetworks: AggkitFailedNetwork[] = [
      ...fanOutFailedNetworks,
      ...dedupedProbeFailures,
    ];

    return {
      data,
      pagination: {
        limit: pageSize,
        ...(merged.exhausted
          ? {}
          : { nextStartAfterCursor: JSON.stringify(merged.nextCursor) }),
      },
      exhausted: merged.exhausted,
      failedNetworks,
    };
  }

  /**
   * Cheap ready-to-claim count: one bounded (single, large) page of
   * bridges+claims per configured network (Tier 1) to build the unclaimed
   * set, then Tier-2 `/l1-info-tree-index` + destination-injected-GER
   * probes bounded to that unclaimed set only — never a full activity scan.
   *
   * FIXED (issue #31, folded into this redesign per its own "Relationship
   * to #30" section): this predicate now calls `resolveInjectedLeafIndex`
   * for an L2 destination, exactly like `toTransaction` does for
   * `getActivity`. Previously it stopped at the source `/l1-info-tree-index`
   * probe, counting a deposit as ready to claim before the destination had
   * actually injected the covering GER — the badge (this method) and the
   * activity list (`getActivity`, via `toTransaction`) disagreed on the
   * exact same row, and acting on the badge built a claim proof that
   * reverted on-chain with `GlobalExitRootInvalid`.
   *
   * FIXED (issue #30 scope item 3): per-row probes now run through
   * `mapWithConcurrencyLimit` (bounded to `READY_PROBE_CONCURRENCY`) instead
   * of an unbounded `Promise.all` — at `pageSize = MAX_PAGE_SIZE` that could
   * put ~1,600 requests in flight against one aggkit instance
   * (comment 3862897115). A genuine probe THROW (as opposed to a healthy
   * "not ready yet" answer) is now surfaced via the returned
   * `failedNetworks` instead of being silently folded into "not ready" —
   * see `AggkitReadyToClaimCountResult` in `types.ts`.
   */
  async getReadyToClaimCount(params: {
    fromAddress: string;
  }): Promise<AggkitReadyToClaimCountResult> {
    const networkIds = this.listNetworkIds();
    const pageSize = MAX_PAGE_SIZE;

    // Mirrors `getActivity`'s guard (comment 3862897421, audit finding C8):
    // without this, `getReadyToClaimCount({ networks: {} })` silently
    // returned `0` for the same config bug `getActivity` now throws for --
    // an unannounced badge-vs-feed asymmetry (an aggregator constructed
    // before config resolves would render an empty feed AND a claimable
    // count of 0, masking the misconfiguration either way).
    if (networkIds.length === 0) {
      throw new Error(
        'AggkitBridgeAggregator.getReadyToClaimCount: no networks configured'
      );
    }

    const fanOutFailedNetworks: AggkitFailedNetwork[] = [];
    const claimsByNetwork = new Map<number, Map<string, AggkitClaim>>();
    const allRows: FetchedBridgeRow[] = [];
    // Keyed to the two REAL feed calls only (mirrors `getActivity`'s
    // all-failed guard) — a network whose only successful call was a
    // claims list still contributes zero unclaimed rows.
    let anyFeedSucceeded = false;

    await Promise.all(
      networkIds.map(async (networkId) => {
        const client = this.clientFor(networkId);

        // Bridges A/B and claims C/D each degrade independently
        // (Promise.allSettled, issue #30 scope item 2) instead of one
        // `Promise.all` failure wiping this network's whole contribution.
        const [[originResult, l1Result], claims] = await Promise.all([
          Promise.allSettled([
            client.getBridges({
              networkId,
              fromAddress: params.fromAddress,
              pageNumber: 1,
              pageSize,
            }),
            client.getBridges({
              networkId: 0,
              networkIds: [networkId],
              fromAddress: params.fromAddress,
              pageNumber: 1,
              pageSize,
            }),
          ]),
          fetchClaimsEnrichment(client, networkId, pageSize),
        ]);

        if (originResult.status === 'fulfilled') {
          anyFeedSucceeded = true;
          for (const bridge of originResult.value.bridges) {
            allRows.push({
              bridge,
              sourceInstanceNetworkId: networkId,
              recordingNetworkId: networkId,
            });
          }
        } else {
          fanOutFailedNetworks.push(
            toFailedNetwork(networkId, originResult.reason)
          );
        }

        if (l1Result.status === 'fulfilled') {
          anyFeedSucceeded = true;
          for (const bridge of l1Result.value.bridges) {
            allRows.push({
              bridge,
              sourceInstanceNetworkId: networkId,
              recordingNetworkId: 0,
            });
          }
        } else {
          fanOutFailedNetworks.push(
            toFailedNetwork(networkId, l1Result.reason)
          );
        }

        mergeClaimsMap(claimsByNetwork, networkId, claims.claimsHere);
        mergeClaimsMap(claimsByNetwork, 0, claims.claimsL1);
        fanOutFailedNetworks.push(...claims.failedNetworks);
      })
    );

    if (!anyFeedSucceeded) {
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

    // Deduped by networkId (first-wins), same rationale as `getActivity`:
    // a single failing endpoint can affect every candidate row, and
    // reporting one entry per affected ROW rather than per DISTINCT FAILING
    // CALL would balloon `failedNetworks` to candidate-count length. A
    // fan-out-level failure for the same network takes priority.
    const seenFailedNetworkIds = new Set(
      fanOutFailedNetworks.map((f) => f.networkId)
    );
    const probeFailures: AggkitFailedNetwork[] = [];
    const onProbeError = (failure: AggkitFailedNetwork): void => {
      if (!seenFailedNetworkIds.has(failure.networkId)) {
        seenFailedNetworkIds.add(failure.networkId);
        probeFailures.push(failure);
      }
    };

    const readyFlags = await mapWithConcurrencyLimit(
      unclaimed,
      READY_PROBE_CONCURRENCY,
      async (row) => {
        let sourceIndex: number | undefined;
        try {
          const probe = await this.clientFor(
            row.sourceInstanceNetworkId
          ).getL1InfoTreeIndex({
            networkId: row.recordingNetworkId,
            depositCount: row.bridge.deposit_count,
          });
          // Narrow on `ready`, never on the numeric value: L1-info-tree
          // leaf index 0 is valid and falsy.
          if (probe.ready) {
            sourceIndex = probe.value;
          }
        } catch (error) {
          // Genuine Tier-2a throw (as opposed to a healthy "not ready yet"
          // answer): surface it instead of silently under-counting.
          onProbeError(toFailedNetwork(row.recordingNetworkId, error));
          return false;
        }
        if (sourceIndex === undefined) {
          return false; // Healthy "not yet" answer -- not a failure.
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
        if (confirmedClaim) {
          return false;
        }

        if (row.bridge.destination_network === 0) {
          // L2->L1: no injection step (mirrors `toTransaction`).
          return true;
        }

        try {
          const resolution = await this.resolveInjectedLeafIndex({
            destinationNetworkId: row.bridge.destination_network,
            sourceL1InfoTreeIndex: sourceIndex,
          });
          // `kind === 'not-ready'` mirrors `toTransaction`'s LEAF_INCLUDED
          // derivation exactly (issue #31): the destination hasn't injected
          // the covering GER yet, so this row is not actually claimable.
          return resolution.kind !== 'not-ready';
        } catch (error) {
          // Genuine Tier-2b throw: surface it instead of silently
          // under-counting (issue #30 scope item 3).
          onProbeError(toFailedNetwork(row.bridge.destination_network, error));
          return false;
        }
      }
    );

    return {
      count: readyFlags.filter(Boolean).length,
      failedNetworks: [...fanOutFailedNetworks, ...probeFailures],
    };
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
      // Find (not index [0]) the claim actually matching the requested
      // global_index (comment 3847451952, audit finding C6): if a proxy ever
      // drops the `global_index` filter param, aggkit returns page 1 of ALL
      // claims for the network, and the caller's claim can sit at any index,
      // not just 0 -- indexing `[0]` would then either show a stranger's
      // claim as the user's (the false-positive direction the original guard
      // closed) or, if that stranger's index happens not to match, wrongly
      // report an actually-claimed deposit as unclaimed (the false-negative
      // direction `[0]`-indexing reopened: `getReadyToClaimCount` counts it
      // as ready and `getActivity` shows a Claim button for a deposit whose
      // claim tx would revert `AlreadyClaimed`). `.find()` checks every
      // returned claim, not just the first.
      const claim = result.claims.find((c) =>
        globalIndexesMatch(c.global_index, bridge.global_index)
      );
      return claim ?? null;
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
