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
  private readonly fetchConfig: RawFetchConfig;

  constructor(config: AggkitBridgeClientConfig) {
    this.networkId = config.networkId;
    this.rootUrl = config.baseUrl.replace(/\/+$/, '');
    this.bridgeApiUrl = `${this.rootUrl}/bridge/v1`;
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
