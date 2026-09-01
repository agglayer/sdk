/**
 * AggkitBridgeClient
 *
 * Single-network typed client for one aggkit `bridge/v1` REST instance.
 * One aggkit REST instance is bound to exactly one L2 network; this
 * client wraps the endpoints consumed by the bridge UI:
 * bridges, claims, l1-info-tree-index, claim-proof, token-mappings,
 * sync-status (and the root health check).
 */

import { AggkitApiError } from './errors';
import { fetchRawText, type RawFetchConfig } from './httpRaw';
import { quoteGlobalIndex } from './parsing';
import type {
  AggkitBridgeClientConfig,
  AggkitBridgesResult,
  AggkitClaimsResult,
  AggkitClaimProof,
  AggkitL1InfoTreeLeaf,
  AggkitNotReadyReason,
  AggkitProbeResult,
  AggkitTokenMappingsResult,
  AggkitSyncStatus,
  AggkitErrorBody,
  AggkitHealthResponse,
  AggkitTrackingData,
  AggkitTrackerErrorData,
} from './types';

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

/** `page_size` max enforced by aggkit (`utils.go` `MaxPageSize`). */
const MAX_PAGE_SIZE = 200;
/** `network_ids` max enforced by aggkit (`utils.go` `MaxNetworkIDs`). */
const MAX_NETWORK_IDS = 5;

/**
 * `/l1-info-tree-index` not-ready detection (comment 3862896539).
 *
 * **Minimum supported aggkit: v0.11.0-rc6.** rc4/rc5 support was dropped by
 * explicit product decision (see the S19 step note in
 * `plans/sdk-pr28-scratch.md`) — this SDK does not attempt to classify
 * rc4/rc5's wire shapes, and a deployment on rc4/rc5 will see a genuine
 * failure on any not-ready state this endpoint reports.
 *
 * On the supported floor (verified: `v0.11.0-rc6`, aggkit #1794 —
 * `httpStatusForSyncerError`, `bridge.go:1764-1786`, wired in via
 * `respondSyncerError`, `bridge.go:1789-1811`, called from
 * `L1InfoTreeIndexForBridgeHandler`, `bridge.go:825-838`): not-yet-indexed
 * errors (`db.ErrNotFound`, `l1infotreesync.ErrNotFound`, `ErrNotOnL1Info`,
 * ...) report **404** with the FIXED body prefix `"l1 info tree index for
 * network id %d and deposit count %d is not available yet, retry later: %s"`
 * (`bridge.go:834`) — present on every not-ready 404 regardless of which
 * underlying not-found error triggered it. **500 is unconditionally a
 * genuine fault on rc6+** — `respondSyncerError`'s `default` case
 * (`bridge.go:836-837`) is the only 500 source in this handler, and it is
 * never a not-ready state.
 *
 * So only **404** is inspected for a not-ready classification, and only
 * EXACT, ground-truth-verified phrasings are matched — never a bare
 * `"not found"` SUBSTRING (comment 3862896539's trap: "not found" is one of
 * the most common substrings in error prose anywhere in aggkit's stack — it
 * interpolates raw error chains into its 500 bodies, e.g. "LER not found for
 * verified batch...", and aggkit-proxy's OWN routing-failure body is literally
 * "bridge service url not found for network..." — see
 * `AGGKIT_PROXY_ROUTING_FAILURE_PATTERN` below). A bare substring match risks
 * silently swallowing a genuine failure as "not ready", stranding a row at
 * BRIDGED forever with no `failedNetworks` entry and no visible error.
 *
 * HISTORY: a rc4/rc5 500-body branch (`L1_INFO_TREE_INDEX_LEGACY_BARE_NOT_FOUND`)
 * previously matched a bare `db.ErrNotFound` 500 body as not-ready (audit
 * finding C1) to keep rc4/rc5 working. That branch, and the rc4/rc5 support it
 * existed for, were removed once the product decision fixed the floor at
 * rc6+ — see the S19 scratch-note entry. `L1_INFO_TREE_INDEX_NOT_READY_PATTERNS`
 * below is now gated to status 404 only; a 500 with either phrase (which can
 * happen only if a nested error chain happens to contain it) is a genuine
 * fault and throws, same as any other 500.
 */
const L1_INFO_TREE_INDEX_NOT_READY_PATTERNS = [
  // rc6+ only (404, via ErrNotOnL1Info) — bridge.go:87.
  'not been included on the l1 info tree',
  // rc6+ only (404) — the FIXED prefix respondSyncerError's notFoundMsg uses
  // for EVERY not-indexed-yet cause, bridge.go:834.
  'is not available yet, retry later',
];

/**
 * aggkit-proxy's OWN routing-failure body — `ErrURLNotFound`,
 * `bridgeservicefinder/interfaces.go:35`,
 * `errors.New("bridge service url not found for network")`. The proxy sits
 * in front of EVERY bridge-service route, so its 404 can arrive on any of the
 * three claim-path endpoints. Excluded up front on all three
 * (`getL1InfoTreeIndex`, `getInjectedL1InfoLeaf`, `getClaimProof`) even though
 * it matches none of their not-ready patterns today — defense in depth per
 * comment 3862896539's explicit ask. A genuine routing failure must never be
 * misclassified as "not ready" — that strands the row forever with no
 * `failedNetworks` entry.
 */
const AGGKIT_PROXY_ROUTING_FAILURE_PATTERN =
  'bridge service url not found for network';

/**
 * 503 syncer-halted body — rc6+ only, shared by ALL THREE claim-path endpoints.
 *
 * The FIXED body `respondSyncerError` writes when `httpStatusForSyncerError`
 * maps the underlying error to `aggkitsync.ErrInconsistentState`
 * (`sync/evmdriver.go:18`, `"state is inconsistent, try again later once the
 * state is consolidated"`) — `errSyncerInconsistent`, `bridge.go:80`:
 * `"a syncer is temporarily inconsistent (reorg being resolved), retry
 * later: %s"`, written at `v0.11.0-rc6:bridgeservice/bridge.go:1800-1803`.
 *
 * `respondSyncerError` is wired into exactly three handlers in rc6+, all three
 * of which the SDK probes on the claim path (rc5 had NONE of them):
 * `L1InfoTreeIndexForBridgeHandler` (`bridge.go:833`),
 * `InjectedL1InfoLeafHandler` (`:915`, `:930`) and `ClaimProofHandler`
 * (`:1066`, `:1083`, `:1092`, `:1106`, `:1122`).
 *
 * MATCHING THE PROSE IS MANDATORY, not cosmetic. It is the only 503 source in
 * `L1InfoTreeIndexForBridgeHandler` (`bridge.go:788-843`) and
 * `InjectedL1InfoLeafHandler` (`:858-939`), but `ClaimProofHandler` has TWO
 * OTHER 503 sources that are genuine CONFIGURATION FAULTS and must keep
 * throwing: `"L1 bridge syncer is not available"` (`bridge.go:1076-1078`;
 * rc5 `:1062-1063`) and `"L2 bridge syncer is not available"`
 * (`bridge.go:1099-1101`; rc5 `:1083-1084`). A blanket "503 means not-ready"
 * would silently turn a misconfigured aggkit into "keep polling forever".
 *
 * See the 503 DECISION note on `SYNCER_INCONSISTENT` in `types.ts`.
 */
const SYNCER_INCONSISTENT_PATTERN = 'a syncer is temporarily inconsistent';

/**
 * `/injected-l1-info-leaf` 404 bodies that mean "not ready yet" rather than a
 * routing/config failure, paired with the reason each maps to.
 *
 * MUST be message-matched: aggkit-proxy also answers 404 with
 * `{"error":"bridge service url not found for network: network N"}`
 * (`__fixtures__/error_404_unknown_network.json`), and treating that as "not
 * ready" would strand rows in LEAF_INCLUDED forever — hence the
 * `AGGKIT_PROXY_ROUTING_FAILURE_PATTERN` exclusion applied before this list.
 *
 * Ground truth (`v0.11.0-rc6:bridgeservice/bridge.go`, byte-identical to
 * `v0.11.0-rc7`; rc5 line numbers from `v0.11.0-rc5`):
 *
 * | reason | 404 body (fixed prefix) | site |
 * |---|---|---|
 * | `DESTINATION_GER_NOT_INJECTED` | `no injected global exit root at or after leaf index %d yet (not injected)` | rc6 `:900-902`, rc5 `:894-896` (unchanged across versions) |
 * | `L1_INFO_LEAF_NOT_INDEXED` | `l1infotreesync has not indexed l1 info tree leaf index %d yet (already injected on L2 per l2gersync), retry later` | rc6 `:916-917` (rc6+ ONLY — rc5 answered 500 at `:909-913`) |
 * | `L1_INFO_LEAF_NOT_INDEXED` | `l1infotreesync has not indexed l1 info tree leaf index %d yet, retry later` | rc6 `:931` (rc6+ ONLY — rc5 answered 500 at `:923-928`) |
 *
 * Audit finding C2: `54c10b9` migrated only `/l1-info-tree-index`, so the two
 * rc6 404s above (and the 503) all threw `AggkitApiError`. The first of them is
 * an ordinary, transient, seconds-to-minutes window on any L2->L2 deposit whose
 * GER *is* injected but whose L1-info leaf `l1infotreesync` has not caught up
 * to — exactly the flood the not-ready union exists to prevent.
 *
 * `'has not indexed l1 info tree leaf index'` is a sufficient and safe anchor
 * for both rc6 bodies (they share that fixed prefix) and cannot collide with
 * the proxy's routing prose. NOTE the second one is currently unreachable
 * through the SDK — it is the `network_id == 0` (mainnet) arm of the handler
 * (`bridge.go:891-893` + `:929-935`), and `resolveInjectedLeafIndex`
 * early-returns for destination 0 — but it is matched anyway so a future
 * caller cannot reintroduce the throw.
 *
 * Minimum supported aggkit: v0.11.0-rc6 (rc4/rc5 support dropped by explicit
 * product decision — see the S19 scratch-note entry). None of these three
 * patterns can be dropped while rc6+ is the deployable target: `not injected`
 * is the unchanged primary case, the other two are the rc6+ `respondSyncerError`
 * additions.
 */
const INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS: ReadonlyArray<{
  pattern: string;
  reason: AggkitNotReadyReason;
}> = [
  // bridge.go:900-902 — unchanged in spirit back to rc5, still current on rc6+.
  { pattern: 'not injected', reason: 'DESTINATION_GER_NOT_INJECTED' },
  // rc6+ only — the fixed prefix shared by bridge.go:916-917 and :931.
  {
    pattern: 'has not indexed l1 info tree leaf index',
    reason: 'L1_INFO_LEAF_NOT_INDEXED',
  },
];

/**
 * `/claim-proof` 404 not-ready anchor — rc6+ only.
 *
 * `ClaimProofHandler` routes FIVE distinct error paths through
 * `respondSyncerError` in rc6+, each with its own fixed `notFoundMsg`; all five
 * share the substring `"has not indexed"`. Ground truth
 * (`v0.11.0-rc6:bridgeservice/bridge.go`, byte-identical to `v0.11.0-rc7`):
 *
 * | 404 body (fixed prefix) | site | rc5 equivalent |
 * |---|---|---|
 * | `l1infotreesync has not indexed l1 info tree leaf index %d yet, retry later` | `:1067` | 500 at `:1052-1054` |
 * | `bridgesync L1 has not indexed deposit count %d yet, retry later` | `:1084` | 500 at `:1068-1070` |
 * | `l1infotreesync has not indexed the local exit root of network id %d for rollup exit root %s yet, retry later` | `:1093-1094` | 500 at `:1077-1079` |
 * | `bridgesync L2 has not indexed deposit count %d yet, retry later` | `:1107` | 500 at `:1089-1091` |
 * | `l1infotreesync has not indexed the rollup exit tree for network id %d and rollup exit root %s yet, retry later` | `:1123-1124` | 500 at `:1104-1109` |
 *
 * All five are "a syncer is a few blocks behind on this specific leaf" — a
 * single wire state as far as a consumer is concerned, so they map to ONE
 * reason (`CLAIM_PROOF_NOT_AVAILABLE`) and the exact prose travels in `detail`.
 *
 * Audit finding C3: before this, `getClaimProof` called `assertOk`, so all five
 * (plus the 503) threw. `/claim-proof` is the LAST call `getClaimInputs` makes
 * — the source is settled and the destination has injected — so throwing there
 * rendered a hard failure for a transient wait. This activates the not-ready
 * arm design §2.2/§2.6 reserved for it; no aggregator change is needed because
 * the union already flows through `getClaimInputs`.
 *
 * Scoped to 404 ONLY: a 500 on this endpoint is unconditionally a genuine
 * fault (`respondSyncerError`'s `internalMsg`), so it must keep throwing.
 *
 * Minimum supported aggkit: v0.11.0-rc6 (rc4/rc5 support dropped by explicit
 * product decision — see the S19 scratch-note entry). This pattern is the
 * rc6+ shape and stays as long as rc6+ is the deployable target; it can be
 * deleted only if aggkit stops classifying these as 404.
 */
const CLAIM_PROOF_NOT_READY_PATTERN = 'has not indexed';

type QueryValue = string | number | boolean | number[] | undefined;

/**
 * Strips trailing `/` characters from `url`.
 *
 * Implemented as a manual backward scan rather than a regex (e.g. `/\/+$/`)
 * because `baseUrl` is library/consumer-supplied input: a regex quantifier
 * anchored at the end of the string is flagged by CodeQL as a potential
 * ReDoS source (polynomial worst-case matching cost), even though this
 * particular pattern isn't exploitable in practice. A plain scan is linear
 * by construction and carries no such risk.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') {
    end--;
  }
  return url.slice(0, end);
}

export class AggkitBridgeClient {
  /** The L2 network id this aggkit instance serves. */
  public readonly networkId: number;

  private readonly rootUrl: string;
  private readonly bridgeApiUrl: string;
  private readonly trackerApiUrl: string;
  private readonly fetchConfig: RawFetchConfig;

  constructor(config: AggkitBridgeClientConfig) {
    this.networkId = config.networkId;
    this.rootUrl = stripTrailingSlashes(config.baseUrl);
    this.bridgeApiUrl = `${this.rootUrl}/bridge/v1`;
    this.trackerApiUrl = `${this.rootUrl}/tracker/v1`;
    this.fetchConfig = {
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      retries: config.retries ?? DEFAULT_RETRIES,
      retryDelay: config.retryDelay ?? DEFAULT_RETRY_DELAY,
    };
  }

  async getBridges(params: {
    networkId: 0 | number;
    fromAddress?: string;
    depositCount?: number;
    networkIds?: number[];
    pageNumber?: number;
    pageSize?: number;
  }): Promise<AggkitBridgesResult> {
    this.assertPageSize(params.pageSize);
    this.assertNetworkIds(params.networkIds);

    const query = this.buildQuery({
      network_id: params.networkId,
      from_address: params.fromAddress,
      deposit_count: params.depositCount,
      network_ids: params.networkIds,
      page_number: params.pageNumber,
      page_size: params.pageSize,
    });

    const { status, text } = await this.requestRaw('/bridges', query);
    this.assertOk('/bridges', status, text);

    return JSON.parse(quoteGlobalIndex(text)) as AggkitBridgesResult;
  }

  async getClaims(params: {
    networkId: 0 | number;
    globalIndex?: string;
    networkIds?: number[];
    includeAllFields?: boolean;
    pageNumber?: number;
    pageSize?: number;
  }): Promise<AggkitClaimsResult> {
    this.assertPageSize(params.pageSize);
    this.assertNetworkIds(params.networkIds);

    const query = this.buildQuery({
      network_id: params.networkId,
      global_index: params.globalIndex,
      network_ids: params.networkIds,
      include_all_fields: params.includeAllFields,
      page_number: params.pageNumber,
      page_size: params.pageSize,
    });

    const { status, text } = await this.requestRaw('/claims', query);
    this.assertOk('/claims', status, text);

    return JSON.parse(quoteGlobalIndex(text)) as AggkitClaimsResult;
  }

  /**
   * Returns the L1-info-tree index for `(networkId, depositCount)`.
   *
   * `networkId` is the RECORDING network — the one whose local exit tree holds
   * the leaf at `depositCount` — never the asset's `origin_network`
   * (comment 3847422009).
   *
   * Answers `{ ready: false, reason, detail }` rather than throwing for three
   * documented "the request succeeded, the deposit just isn't ready" shapes
   * — DATA, not an error (comment 3847523270):
   * - `'SOURCE_NOT_ON_L1_INFO_TREE'` — not yet included on the L1 info tree.
   *   Carried as a **404** (aggkit #1794 remapped this endpoint's statuses —
   *   comment 3862896539). See `L1_INFO_TREE_INDEX_NOT_READY_PATTERNS`.
   * - `'SYNCER_INCONSISTENT'` — the syncer is halted resolving a reorg (503).
   *   See `SYNCER_INCONSISTENT_PATTERN` and the DECISION note on this reason
   *   in `types.ts`.
   *
   * Any genuine failure — a non-numeric 2xx body, an unmatched 404/503, ANY
   * 500 (unconditionally a genuine fault on this endpoint's minimum
   * supported aggkit, v0.11.0-rc6+), the aggkit-proxy's own routing-failure
   * prose, or any other status — still throws `AggkitApiError`
   * (comment 3847600104).
   */
  async getL1InfoTreeIndex(params: {
    networkId: 0 | number;
    depositCount: number;
  }): Promise<AggkitProbeResult<number>> {
    const query = this.buildQuery({
      network_id: params.networkId,
      deposit_count: params.depositCount,
    });

    const { status, text } = await this.requestRaw(
      '/l1-info-tree-index',
      query
    );

    if (status >= 200 && status < 300) {
      const value = Number(text.trim());
      if (Number.isNaN(value)) {
        throw new AggkitApiError({
          message: `Unexpected non-numeric body for /l1-info-tree-index: ${text}`,
          httpStatus: status,
          endpoint: '/l1-info-tree-index',
          body: text,
        });
      }
      return { ready: true, value };
    }

    const message = this.parseErrorMessage(text);
    const lowerMessage = message.toLowerCase();
    const isProxyRoutingFailure = lowerMessage.includes(
      AGGKIT_PROXY_ROUTING_FAILURE_PATTERN
    );

    if (!isProxyRoutingFailure) {
      // 404 ONLY. On this SDK's minimum supported aggkit (v0.11.0-rc6+), a
      // 500 on this endpoint is UNCONDITIONALLY a genuine fault
      // (`respondSyncerError`'s `default` case, `bridge.go:836-837`) — never
      // a not-ready state. rc4/rc5 (which answered this same not-ready
      // condition as a 500) are no longer a supported deployment target; see
      // this file's module-doc-level note above `L1_INFO_TREE_INDEX_NOT_READY_PATTERNS`.
      if (
        status === 404 &&
        L1_INFO_TREE_INDEX_NOT_READY_PATTERNS.some((pattern) =>
          lowerMessage.includes(pattern)
        )
      ) {
        return {
          ready: false,
          reason: 'SOURCE_NOT_ON_L1_INFO_TREE',
          detail: message,
        };
      }

      if (
        status === 503 &&
        lowerMessage.includes(SYNCER_INCONSISTENT_PATTERN)
      ) {
        return {
          ready: false,
          reason: 'SYNCER_INCONSISTENT',
          detail: message,
        };
      }
    }

    throw new AggkitApiError({
      message,
      httpStatus: status,
      endpoint: '/l1-info-tree-index',
      body: text,
    });
  }

  /**
   * Builds the local-exit-tree branch for leaf `depositCount` of `networkId`'s
   * tree, against L1-info-tree leaf `leafIndex`.
   *
   * `networkId` is the RECORDING network, never the asset's `origin_network`
   * (comment 3847422009): `deposit_count` is a per-tree counter, so naming the
   * wrong tree yields a well-formed proof for an unrelated deposit.
   *
   * Returns `AggkitProbeResult`. The `ready: false` arm — the slot design
   * §2.2/§2.6 reserved and `54c10b9` left unactivated — is now LIVE for
   * aggkit v0.11.0-rc6+ (audit finding C3):
   *
   * - `'CLAIM_PROOF_NOT_AVAILABLE'` — rc6+ only: **404** with one of the five
   *   fixed `"... has not indexed ..."` bodies `ClaimProofHandler` routes
   *   through `respondSyncerError`. A syncer is a few blocks behind on this
   *   specific leaf; the request was valid. See
   *   `CLAIM_PROOF_NOT_READY_PATTERN` for the five bodies and their sites.
   * - `'SYNCER_INCONSISTENT'` — rc6+ only: **503** whose body carries the fixed
   *   `errSyncerInconsistent` prose. See `SYNCER_INCONSISTENT_PATTERN`.
   *
   * Everything else still throws `AggkitApiError`: any 500 (unconditionally a
   * genuine fault, e.g. `"failed to get l1 info tree leaf for index N:
   * sql: no rows in result set"`), any 400, the proxy's own routing-failure
   * prose, and — critically — this handler's TWO OTHER 503s,
   * `"L1 bridge syncer is not available"` and `"L2 bridge syncer is not
   * available"`, which are configuration faults, not waiting states. That is
   * why the 503 branch is prose-gated rather than status-gated.
   *
   * Minimum supported aggkit: v0.11.0-rc6.
   */
  async getClaimProof(params: {
    networkId: 0 | number;
    leafIndex: number;
    depositCount: number;
  }): Promise<AggkitProbeResult<AggkitClaimProof>> {
    const query = this.buildQuery({
      network_id: params.networkId,
      leaf_index: params.leafIndex,
      deposit_count: params.depositCount,
    });

    const { status, text } = await this.requestRaw('/claim-proof', query);

    if (status >= 200 && status < 300) {
      return { ready: true, value: JSON.parse(text) as AggkitClaimProof };
    }

    const message = this.parseErrorMessage(text);
    const lowerMessage = message.toLowerCase();

    if (!lowerMessage.includes(AGGKIT_PROXY_ROUTING_FAILURE_PATTERN)) {
      if (
        status === 404 &&
        lowerMessage.includes(CLAIM_PROOF_NOT_READY_PATTERN)
      ) {
        return {
          ready: false,
          reason: 'CLAIM_PROOF_NOT_AVAILABLE',
          detail: message,
        };
      }

      if (
        status === 503 &&
        lowerMessage.includes(SYNCER_INCONSISTENT_PATTERN)
      ) {
        return {
          ready: false,
          reason: 'SYNCER_INCONSISTENT',
          detail: message,
        };
      }
    }

    throw new AggkitApiError({
      message,
      httpStatus: status,
      endpoint: '/claim-proof',
      body: text,
    });
  }

  /**
   * Destination-side GER-injection probe.
   * For an L2 `networkId`, aggkit returns the leaf of the FIRST injected global exit
   * root at or AFTER `leafIndex` (so `result.l1_info_tree_index >= leafIndex`).
   * For `networkId === 0` it returns the leaf AT `leafIndex`.
   *
   * Answers `{ ready: false, reason, detail }` for the documented not-ready
   * branches — a successful "not yet" answer, not an error
   * (comment 3847523270):
   *
   * - **404** `'DESTINATION_GER_NOT_INJECTED'` — the destination has not
   *   injected a GER at or after this index yet.
   * - **404** `'L1_INFO_LEAF_NOT_INDEXED'` (audit finding C2) —
   *   `l1infotreesync` has not indexed the L1-info-tree leaf yet; on the first
   *   of its two bodies the GER *is* already injected on L2. See
   *   `INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS` for both bodies and sites.
   * - **503** `'SYNCER_INCONSISTENT'` (audit finding C2) — a syncer is halted
   *   resolving a reorg. See `SYNCER_INCONSISTENT_PATTERN`.
   *
   * Every other non-2xx throws `AggkitApiError` — including any other 404 (the
   * proxy's `"bridge service url not found"` is excluded explicitly and up
   * front), the genuine-fault 500 `"failed to get injected global exit root for
   * leaf index=%d, error: %s"` (`v0.11.0-rc6:bridgeservice/bridge.go:906-910`),
   * and any 503 without the fixed syncer-inconsistent prose. Treating those as
   * not-ready would strand rows in LEAF_INCLUDED forever.
   *
   * Minimum supported aggkit: v0.11.0-rc6.
   */
  async getInjectedL1InfoLeaf(params: {
    networkId: 0 | number;
    leafIndex: number;
  }): Promise<AggkitProbeResult<AggkitL1InfoTreeLeaf>> {
    const query = this.buildQuery({
      network_id: params.networkId,
      leaf_index: params.leafIndex,
    });

    const { status, text } = await this.requestRaw(
      '/injected-l1-info-leaf',
      query
    );

    if (status >= 200 && status < 300) {
      return {
        ready: true,
        value: JSON.parse(text) as AggkitL1InfoTreeLeaf,
      };
    }

    const message = this.parseErrorMessage(text);
    const lowerMessage = message.toLowerCase();

    if (!lowerMessage.includes(AGGKIT_PROXY_ROUTING_FAILURE_PATTERN)) {
      if (status === 404) {
        const matched = INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS.find((entry) =>
          lowerMessage.includes(entry.pattern)
        );
        if (matched) {
          return {
            ready: false,
            reason: matched.reason,
            detail: message,
          };
        }
      }

      if (
        status === 503 &&
        lowerMessage.includes(SYNCER_INCONSISTENT_PATTERN)
      ) {
        return {
          ready: false,
          reason: 'SYNCER_INCONSISTENT',
          detail: message,
        };
      }
    }

    throw new AggkitApiError({
      message,
      httpStatus: status,
      endpoint: '/injected-l1-info-leaf',
      body: text,
    });
  }

  async getTokenMappings(params: {
    networkId: number;
    originTokenAddress?: string;
    pageNumber?: number;
    pageSize?: number;
  }): Promise<AggkitTokenMappingsResult> {
    this.assertPageSize(params.pageSize);

    const query = this.buildQuery({
      network_id: params.networkId,
      origin_token_address: params.originTokenAddress,
      page_number: params.pageNumber,
      page_size: params.pageSize,
    });

    const { status, text } = await this.requestRaw('/token-mappings', query);
    this.assertOk('/token-mappings', status, text);

    return JSON.parse(text) as AggkitTokenMappingsResult;
  }

  /**
   * Sends `network_id` explicitly: through
   * aggkit-proxy, an unqualified `/sync-status` request 400s ("missing
   * mandatory query parameter: network_id") because the proxy has no default
   * network to route to. Safe against a direct aggkit instance too —
   * `GetSyncStatusHandler` never reads `network_id`; it always reports that
   * instance's own L1+L2 status regardless of the query.
   */
  async getSyncStatus(): Promise<AggkitSyncStatus> {
    const query = this.buildQuery({ network_id: this.networkId });
    const { status, text } = await this.requestRaw('/sync-status', query);
    this.assertOk('/sync-status', status, text);

    return JSON.parse(text) as AggkitSyncStatus;
  }

  /**
   * Root health check (`GET {baseUrl}/`, not under `/bridge/v1`). Not part
   * of the aggregator's needs — provided as a thin, low-risk extension over
   * the same fetch/retry plumbing.
   */
  async getHealth(): Promise<AggkitHealthResponse> {
    const url = `${this.rootUrl}/`;
    const { status, text } = await fetchRawText(url, this.fetchConfig);

    if (status < 200 || status >= 300) {
      throw new AggkitApiError({
        message: this.parseErrorMessage(text),
        httpStatus: status,
        endpoint: '/',
        body: text,
      });
    }

    return JSON.parse(text) as AggkitHealthResponse;
  }

  /**
   * Bridge tracker lookup (aggkit `tracker/v1`,
   * `GET /tracker/v1/network/{network_id}/tx/{tx_hash}`, docs/bridgetracker/API.md).
   * Types were fixture-derived from a v0.11.0-rc4 enclave and live-verified
   * unchanged on v0.11.0-rc5 (agglayer/aggkit#1781, fixed in PR #1784 —
   * see `types.ts`'s tracker-section module doc for the full wire-format
   * writeup). Registers `txHash` in the tracker's supervised list if it was not
   * already tracked, and always returns `200 OK` with the current
   * `AggkitTrackingData` — `bridge_status`/`step_index`/`all_steps` are
   * `null` until the tracker resolves the bridge (or forever, if it gives up
   * and sets `error` instead).
   *
   * `networkId` defaults to `this.networkId` (the network this client
   * instance is bound to) but MUST be passed explicitly by callers that
   * route L1 (network 0) traffic through an L2-keyed client instance — e.g.
   * `AggkitBridgeAggregator.clientForNetworkOrL1` — whose own `this.networkId`
   * is not 0. The URL path always uses the `networkId` argument, never the
   * instance's own `this.networkId` implicitly.
   *
   * **Terminal semantics** — stop polling once EITHER is true:
   * - `tracking_status === 'finished'` (the bridge reached its last step,
   *   `Claimed`).
   * - `tracking_status === 'error'` AND `bridge_status === null` — the
   *   tracker gave up ever resolving the bridge at all (tx not found, or not
   *   a bridge tx). This is distinct from a per-step error inside
   *   `all_steps[i].error`: those are non-terminal — the tracker retries
   *   them on its own. Note that a per-step error ALSO reports
   *   `tracking_status: 'error'` (aggkit derives it from the step at
   *   `step_index` — `bridgetracker/domain/tracking_data.go`), just with
   *   `bridge_status` populated — which is exactly why the terminal check
   *   must include `bridge_status === null`, not `tracking_status` alone.
   *
   * **Polling guidance**: the tracker has no push/subscription channel, only
   * this REST lookup, so callers must poll. ~5s between calls is a good
   * default (matches this SDK's own dev-ui consumer) — stop as soon as the
   * terminal condition above is met, and keep polling through any
   * non-terminal state, including a regression back to `'registered'` with
   * `all_steps: null` (see below).
   *
   * **Server-side registration/eviction**: the FIRST call for a given
   * `(networkId, txHash)` pair registers it with the tracker; that initial
   * response, and any poll before the tracker resolves the bridge, comes
   * back as `tracking_status: 'registered'` with `bridge_status`,
   * `step_index`, and `all_steps` all `null` — this is normal, not an error.
   * The tracker is stateful with a bounded retention window
   * (`RetentionPeriod`, 30m in the kurtosis-cdk devnet config); if a
   * tracked-but-not-yet-terminal bridge is evicted, the next poll silently
   * re-registers it from scratch (`'registered'`, `all_steps: null` again)
   * rather than erroring — callers should treat this the same as the
   * original registration, not as a regression to be surfaced to the user.
   */
  async getBridgeTracking(
    txHash: string,
    networkId: number = this.networkId
  ): Promise<AggkitTrackingData> {
    const url = `${this.trackerApiUrl}/network/${networkId}/tx/${txHash}`;
    const { status, text } = await fetchRawText(url, this.fetchConfig);

    if (status < 200 || status >= 300) {
      throw new AggkitApiError({
        message: this.parseTrackerErrorMessage(text),
        httpStatus: status,
        endpoint: '/tracker/v1/network/{network_id}/tx/{tx_hash}',
        body: text,
      });
    }

    return JSON.parse(text) as AggkitTrackingData;
  }

  private async requestRaw(
    endpoint: string,
    query: string
  ): Promise<{ status: number; text: string }> {
    const url = query
      ? `${this.bridgeApiUrl}${endpoint}?${query}`
      : `${this.bridgeApiUrl}${endpoint}`;
    return fetchRawText(url, this.fetchConfig);
  }

  private assertOk(endpoint: string, status: number, text: string): void {
    if (status >= 200 && status < 300) {
      return;
    }
    throw new AggkitApiError({
      message: this.parseErrorMessage(text),
      httpStatus: status,
      endpoint,
      body: text,
    });
  }

  private parseErrorMessage(text: string): string {
    try {
      const parsed = JSON.parse(text) as AggkitErrorBody;
      return typeof parsed.error === 'string' ? parsed.error : text;
    } catch {
      return text;
    }
  }

  /**
   * The bridge tracker's error body (`ErrorData`) is `{"code", "message"}`,
   * NOT the bridge-service's `{"error"}` shape `parseErrorMessage` handles —
   * see `AggkitTrackerErrorData`.
   */
  private parseTrackerErrorMessage(text: string): string {
    try {
      const parsed = JSON.parse(text) as AggkitTrackerErrorData;
      return typeof parsed.message === 'string' ? parsed.message : text;
    } catch {
      return text;
    }
  }

  private assertPageSize(pageSize: number | undefined): void {
    if (pageSize !== undefined && pageSize > MAX_PAGE_SIZE) {
      throw new RangeError(
        `pageSize must be <= ${MAX_PAGE_SIZE} (received ${pageSize})`
      );
    }
  }

  private assertNetworkIds(networkIds: number[] | undefined): void {
    if (networkIds !== undefined && networkIds.length > MAX_NETWORK_IDS) {
      throw new RangeError(
        `networkIds must contain at most ${MAX_NETWORK_IDS} entries (received ${networkIds.length})`
      );
    }
  }

  private buildQuery(params: Record<string, QueryValue>): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) {
          continue;
        }
        parts.push(
          `${encodeURIComponent(key)}=${encodeURIComponent(value.join(','))}`
        );
        continue;
      }

      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      );
    }

    return parts.join('&');
  }
}
