/**
 * AggkitBridgeClient
 *
 * Single-network typed client for one aggkit `bridge/v1` REST instance.
 * One aggkit REST instance is bound to exactly one L2 network (design.md
 * §0.1); this client wraps the endpoints consumed by the bridge UI:
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
 * Substrings of the aggkit `/l1-info-tree-index` 500 error message that mean
 * "not claimable yet" rather than a genuine failure (design.md §4.2, §3.2):
 * - "this bridge has not been included on the L1 Info Tree yet"
 * - "not found" (L2-origin deposits, pre-settlement)
 */
const L1_INFO_TREE_INDEX_NOT_READY_PATTERNS = [
  'not been included',
  'not found',
];

/**
 * Substrings of the `/injected-l1-info-leaf` 404 body that mean "destination GER
 * not injected yet" rather than a routing/config failure. MUST be message-matched:
 * aggkit-proxy also answers 404 with `{"error":"bridge service url not found for
 * network: network N"}` (fixtures/error_404_unknown_network.json), and treating
 * that as "not ready" would strand rows in LEAF_INCLUDED forever (design.md §3.2).
 */
const INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS = ['not injected'];

type QueryValue = string | number | boolean | number[] | undefined;

export class AggkitBridgeClient {
  /** The L2 network id this aggkit instance serves. */
  public readonly networkId: number;

  private readonly rootUrl: string;
  private readonly bridgeApiUrl: string;
  private readonly trackerApiUrl: string;
  private readonly fetchConfig: RawFetchConfig;

  constructor(config: AggkitBridgeClientConfig) {
    this.networkId = config.networkId;
    this.rootUrl = config.baseUrl.replace(/\/+$/, '');
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
   * Returns the L1-info-tree index for `(networkId, depositCount)`, or
   * `null` when aggkit reports the deposit is not yet included on the L1
   * info tree (its documented 500 branches) — see
   * `L1_INFO_TREE_INDEX_NOT_READY_PATTERNS`. Any other error still throws.
   */
  async getL1InfoTreeIndex(params: {
    networkId: 0 | number;
    depositCount: number;
  }): Promise<number | null> {
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
      return value;
    }

    if (status === 500) {
      const message = this.parseErrorMessage(text);
      const lowerMessage = message.toLowerCase();
      const notReady = L1_INFO_TREE_INDEX_NOT_READY_PATTERNS.some((pattern) =>
        lowerMessage.includes(pattern)
      );
      if (notReady) {
        return null;
      }
      throw new AggkitApiError({
        message,
        httpStatus: status,
        endpoint: '/l1-info-tree-index',
        body: text,
      });
    }

    throw new AggkitApiError({
      message: this.parseErrorMessage(text),
      httpStatus: status,
      endpoint: '/l1-info-tree-index',
      body: text,
    });
  }

  async getClaimProof(params: {
    networkId: 0 | number;
    leafIndex: number;
    depositCount: number;
  }): Promise<AggkitClaimProof> {
    const query = this.buildQuery({
      network_id: params.networkId,
      leaf_index: params.leafIndex,
      deposit_count: params.depositCount,
    });

    const { status, text } = await this.requestRaw('/claim-proof', query);
    this.assertOk('/claim-proof', status, text);

    return JSON.parse(text) as AggkitClaimProof;
  }

  /**
   * Destination-side GER-injection probe (design.md §3.2).
   * For an L2 `networkId`, aggkit returns the leaf of the FIRST injected global exit
   * root at or AFTER `leafIndex` (so `result.l1_info_tree_index >= leafIndex`).
   * For `networkId === 0` it returns the leaf AT `leafIndex`.
   * Returns `null` ONLY for the documented 404 "not injected" branch; every other
   * non-2xx (incl. any other 404, e.g. the proxy's "bridge service url not found")
   * throws `AggkitApiError`.
   */
  async getInjectedL1InfoLeaf(params: {
    networkId: 0 | number;
    leafIndex: number;
  }): Promise<AggkitL1InfoTreeLeaf | null> {
    const query = this.buildQuery({
      network_id: params.networkId,
      leaf_index: params.leafIndex,
    });

    const { status, text } = await this.requestRaw(
      '/injected-l1-info-leaf',
      query
    );

    if (status >= 200 && status < 300) {
      return JSON.parse(text) as AggkitL1InfoTreeLeaf;
    }

    if (status === 404) {
      const message = this.parseErrorMessage(text);
      const lowerMessage = message.toLowerCase();
      const notReady = INJECTED_L1_INFO_LEAF_NOT_READY_PATTERNS.some(
        (pattern) => lowerMessage.includes(pattern)
      );
      if (notReady) {
        return null;
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
   * Sends `network_id` explicitly (design.md §2.3, gap G2): through
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
   * of the canonical `AggkitBridgeClient` surface in design.md §4.1, but
   * requested as an S4 type/coverage item and provided here as a thin,
   * low-risk extension over the same fetch/retry plumbing.
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
   * Bridge tracker lookup (aggkit v0.11.0-rc4 `tracker/v1`,
   * `GET /tracker/v1/network/{network_id}/tx/{tx_hash}`, docs/bridgetracker/API.md).
   * Registers `txHash` in the tracker's supervised list if it was not
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
