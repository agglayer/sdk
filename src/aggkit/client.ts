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
 * aggkit's wire format for this endpoint changed mid-rc-series:
 *
 * - **rc4/rc5** (verified: `v0.11.0-rc4`/`v0.11.0-rc5`,
 *   `bridgeservice/bridge.go:783-840` — identical on both tags): every
 *   failure, not-ready included, is reported as **500** with body
 *   `"failed to get l1 info tree index for network id %d and deposit count
 *   %d, error: %s"`, `%s` being the raw underlying error — either
 *   `ErrNotOnL1Info`'s `"this bridge has not been included on the L1 Info
 *   Tree yet"` (`bridge.go:87`), or, for some pre-settlement L2-origin
 *   deposits, a bare `"not found"` (`db.ErrNotFound`, `db/sqlite.go:17`).
 * - **rc6+** (verified: `v0.11.0-rc6`, aggkit #1794 — `httpStatusForSyncerError`,
 *   `bridge.go:1764-1786`, wired in via `respondSyncerError`,
 *   `bridge.go:1789-1811`, called from `L1InfoTreeIndexForBridgeHandler`,
 *   `bridge.go:825-838`): not-yet-indexed errors (`db.ErrNotFound`,
 *   `l1infotreesync.ErrNotFound`, `ErrNotOnL1Info`, ...) now report **404**
 *   with the FIXED body prefix `"l1 info tree index for network id %d and
 *   deposit count %d is not available yet, retry later: %s"`
 *   (`bridge.go:834`) — present on every not-ready 404 regardless of which
 *   underlying not-found error triggered it, and genuine faults stay 500
 *   with the SAME body format as rc4/rc5 above (`bridge.go:836-837`, byte-
 *   for-byte unchanged).
 *
 * So both statuses must be inspected (404 rc6, 500 rc4/rc5-and-genuine-rc6),
 * and only these two EXACT phrasings are matched — never a bare "not found"
 * (comment 3862896539's trap: "not found" is one of the most common
 * substrings in error prose anywhere in aggkit's stack — it interpolates raw
 * error chains into its 500 bodies, e.g. "LER not found for verified
 * batch...", and aggkit-proxy's OWN routing-failure body is literally
 * "bridge service url not found for network..." — see
 * `AGGKIT_PROXY_ROUTING_FAILURE_PATTERN` below). A bare match risks silently
 * swallowing a genuine failure as "not ready", stranding a row at BRIDGED
 * forever with no `failedNetworks` entry and no visible error.
 *
 * DELETION CONDITION for the rc4/rc5 500-pattern-matching branch: once the
 * SDK's supported aggkit floor is >= v0.11.0-rc6 (i.e. rc4/rc5 are no longer
 * a deployable target), the 500 body can no longer carry a not-ready
 * classification (rc6+ 500 is unconditionally a genuine fault) — the 500
 * check in `getL1InfoTreeIndex` becomes dead and can be deleted, along with
 * the "not been included on the L1 Info Tree" pattern if no other 500 source
 * needs it.
 */
const L1_INFO_TREE_INDEX_NOT_READY_PATTERNS = [
  // rc4/rc5 (500) and rc6+ (404, via ErrNotOnL1Info) — bridge.go:87.
  'not been included on the l1 info tree',
  // rc6+ only (404) — the FIXED prefix respondSyncerError's notFoundMsg uses
  // for EVERY not-indexed-yet cause, bridge.go:834.
  'is not available yet, retry later',
];

/**
 * aggkit-proxy's OWN routing-failure body — `ErrURLNotFound`,
 * `bridgeservicefinder/interfaces.go:35`,
 * `errors.New("bridge service url not found for network")`. The proxy sits
 * in front of every bridge-service route, `/l1-info-tree-index` included, so
 * its 404 can arrive here too. MUST be excluded even though it never matches
 * `L1_INFO_TREE_INDEX_NOT_READY_PATTERNS` today — defense in depth per
 * comment 3862896539's explicit ask, and because it collides with the same
 * hazard the sibling `INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS` comment
 * below already warns about for a different endpoint. A genuine routing
 * failure must never be misclassified as "not ready" — that strands the row
 * forever with no `failedNetworks` entry.
 */
const AGGKIT_PROXY_ROUTING_FAILURE_PATTERN =
  'bridge service url not found for network';

/**
 * `/l1-info-tree-index` 503 (rc6+ only — verified `v0.11.0-rc6`): the FIXED
 * body `respondSyncerError` writes when `httpStatusForSyncerError` maps the
 * underlying error to `aggkitsync.ErrInconsistentState`
 * (`sync/evmdriver.go:18`, `"state is inconsistent, try again later once the
 * state is consolidated"`) — `errSyncerInconsistent`, `bridge.go:80`:
 * `"a syncer is temporarily inconsistent (reorg being resolved), retry
 * later: %s"`, written at `bridge.go:1803`. Confirmed this is the ONLY 503
 * source inside `L1InfoTreeIndexForBridgeHandler` (`bridge.go:783-840`) —
 * no other branch in that handler sets `StatusServiceUnavailable` — so this
 * fixed prefix reliably discriminates it from an unrelated 503 (e.g. a
 * different handler's "syncer is not available" misconfiguration, or a
 * proxy-level outage). See the 503 DECISION note on `SYNCER_INCONSISTENT` in
 * `types.ts`.
 */
const L1_INFO_TREE_INDEX_SYNCER_INCONSISTENT_PATTERN =
  'a syncer is temporarily inconsistent';

/**
 * Substrings of the `/injected-l1-info-leaf` 404 body that mean "destination GER
 * not injected yet" rather than a routing/config failure. MUST be message-matched:
 * aggkit-proxy also answers 404 with `{"error":"bridge service url not found for
 * network: network N"}` (fixtures/error_404_unknown_network.json), and treating
 * that as "not ready" would strand rows in LEAF_INCLUDED forever.
 */
const INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS = ['not injected'];

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
   *   Carried as a 500 on aggkit rc4/rc5, or a 404 on rc6+ (aggkit #1794
   *   remapped this endpoint's statuses — comment 3862896539). See
   *   `L1_INFO_TREE_INDEX_NOT_READY_PATTERNS`.
   * - `'SYNCER_INCONSISTENT'` — rc6+ only: the syncer is halted resolving a
   *   reorg (503). See `L1_INFO_TREE_INDEX_SYNCER_INCONSISTENT_PATTERN` and
   *   the DECISION note on this reason in `types.ts`.
   *
   * Any genuine failure — a non-numeric 2xx body, an unmatched 404/500/503,
   * the aggkit-proxy's own routing-failure prose, or any other status — still
   * throws `AggkitApiError` (comment 3847600104).
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
      if (
        (status === 404 || status === 500) &&
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
        lowerMessage.includes(L1_INFO_TREE_INDEX_SYNCER_INCONSISTENT_PATTERN)
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
   * Returns `AggkitProbeResult` for symmetry with the other two claim-path
   * probes. **The `ready: false` arm is currently UNREACHABLE and that is
   * deliberate — do not delete it.** This endpoint has no known not-ready
   * branch today: its 500 (`sql: no rows in result set`) and 400 are genuine
   * errors and keep throwing via `assertOk`. The arm exists so aggkit
   * v0.11.0-rc6's not-ready classification can be added to this endpoint
   * without another breaking signature change, and so callers are already
   * forced to narrow.
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
    this.assertOk('/claim-proof', status, text);

    return { ready: true, value: JSON.parse(text) as AggkitClaimProof };
  }

  /**
   * Destination-side GER-injection probe.
   * For an L2 `networkId`, aggkit returns the leaf of the FIRST injected global exit
   * root at or AFTER `leafIndex` (so `result.l1_info_tree_index >= leafIndex`).
   * For `networkId === 0` it returns the leaf AT `leafIndex`.
   *
   * Answers `{ ready: false, reason: 'DESTINATION_GER_NOT_INJECTED', detail }`
   * ONLY for the documented 404 "not injected" branch — a successful "not yet"
   * answer, not an error (comment 3847523270). Every other non-2xx (incl. any
   * other 404, e.g. the proxy's "bridge service url not found") throws
   * `AggkitApiError`; treating those as not-ready would strand rows forever.
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

    if (status === 404) {
      const message = this.parseErrorMessage(text);
      const lowerMessage = message.toLowerCase();
      const notReady = INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS.some(
        (pattern) => lowerMessage.includes(pattern)
      );
      if (notReady) {
        return {
          ready: false,
          reason: 'DESTINATION_GER_NOT_INJECTED',
          detail: message,
        };
      }
    }

    throw new AggkitApiError({
      message: this.parseErrorMessage(text),
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
