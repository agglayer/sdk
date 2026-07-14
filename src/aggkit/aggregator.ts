/**
 * AggkitBridgeAggregator
 *
 * Multi-network aggregation + status derivation + token metadata over one
 * `AggkitBridgeClient` per configured L2 network. Implements design.md §2
 * (activity fan-out/merge/cursor), §3 (status derivation state machine),
 * §3.7 (cheap ready-to-claim count), §7 (claim-input orchestration) and §5
 * (token metadata composition).
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
  AggkitClaimProof,
  AggkitFailedNetwork,
  AggkitPageCursor,
  AggkitTokenMetadata,
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

function decodeCursor(cursor: string | undefined): AggkitPageCursor {
  if (!cursor) {
    return {};
  }
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as AggkitPageCursor;
    }
    return {};
  } catch {
    return {};
  }
}

function isNativeTokenAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}

/** One page of a single paginated fan-out call (design.md §2.3). */
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
  /** The configured L2 network whose instance this row was fetched via (§2.1). */
  sourceInstanceNetworkId: number;
  /**
   * The network whose LOCAL EXIT TREE recorded this deposit — i.e. the
   * `network_id` the fan-out call itself used, NOT `bridge.origin_network`
   * (design.md §3, "third case"). Call A (`getBridges({ networkId: n })`)
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

/** Result of fanning out the four calls (§2.1 A-D) for one configured network. */
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
   * instance's embedded L1 syncer serves `network_id=0` queries identically
   * (design.md §0.1). Mirrors the routing `getClaimInputs` already applies
   * for the L1-origin case, generalized for callers (like `getTokenMetadata`)
   * that only have a bare `networkId`, not an explicit origin/destination
   * pair to pick a specific instance from.
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

  listNetworkIds(): number[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Fan-out + join + status derivation (design.md §2, §3). Never rejects if
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

    // Dedupe by bridge_hash (unique per event, design.md §2.2).
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

    const data = await Promise.all(
      deduped.map((row) =>
        this.toTransaction(
          row.bridge,
          row.sourceInstanceNetworkId,
          row.recordingNetworkId,
          claimsByNetwork
        )
      )
    );

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
   * Cheap ready-to-claim count (design.md §3.7): one bounded (single, large)
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
        const probe = await this.clientFor(
          row.sourceInstanceNetworkId
        ).getL1InfoTreeIndex({
          networkId: row.recordingNetworkId,
          depositCount: row.bridge.deposit_count,
        });

        if (probe === null) {
          return false;
        }

        // Tier-1 membership only checked page 1 of /claims — bounded, cheap,
        // and wrong once a network's total claims exceed one page (§ bug b).
        // For candidates that passed the leaf-included probe (i.e. that
        // would otherwise be counted READY_TO_CLAIM), confirm with a
        // targeted per-candidate query before counting them.
        const confirmedClaim = await this.confirmClaimed(
          row.bridge,
          row.sourceInstanceNetworkId
        );
        return confirmedClaim === null;
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
    // instance's own embedded L1 syncer (design.md §0.1) — use the instance
    // this row was already fetched through. Claims recorded on a configured
    // L2 network must be queried via that network's own instance (aggkit
    // rejects `network_id`s it doesn't serve).
    const client =
      destinationNetworkId === 0
        ? this.clientFor(sourceInstanceNetworkId)
        : this.clients.get(destinationNetworkId);

    if (!client) {
      // No configured instance can confirm this destination network's
      // claims (e.g. an unconfigured L2->L2 destination, design.md §3.5).
      // Not more precise than the Tier-1/Tier-2 result already computed.
      return null;
    }

    try {
      const result = await client.getClaims({
        networkId: destinationNetworkId,
        globalIndex: bridge.global_index,
      });
      return result.claims[0] ?? null;
    } catch {
      // The confirmation query is a correctness backstop, not a hard
      // dependency — if it fails, fall back to the Tier-2 probe result
      // rather than failing the whole activity/count call.
      return null;
    }
  }

  /**
   * Single-tx claim inputs (design.md §7): resolves the L1-info-tree index
   * then the claim proof. Throws `AggkitApiError` if the deposit is not yet
   * claimable (l1-info-tree-index probe returns null).
   */
  async getClaimInputs(params: {
    originNetworkId: number;
    destinationNetworkId: number;
    depositCount: number;
  }): Promise<{ leafIndex: number; proof: AggkitClaimProof }> {
    const { originNetworkId, destinationNetworkId, depositCount } = params;

    // L1-origin (network 0) has no dedicated instance; its L1 info tree is
    // read via the destination L2's instance (design.md §0.1). L2-origin
    // deposits are read via their own origin instance.
    const client =
      originNetworkId === 0
        ? this.clientFor(destinationNetworkId)
        : this.clientFor(originNetworkId);

    const leafIndex = await client.getL1InfoTreeIndex({
      networkId: originNetworkId,
      depositCount,
    });

    if (leafIndex === null) {
      throw new AggkitApiError({
        message:
          `Deposit (originNetworkId=${originNetworkId}, depositCount=${depositCount}) ` +
          `is not yet claimable: not included on the L1 info tree`,
        httpStatus: 500,
        endpoint: '/l1-info-tree-index',
      });
    }

    const proof = await client.getClaimProof({
      networkId: originNetworkId,
      leafIndex,
      depositCount,
    });

    return { leafIndex, proof };
  }

  /**
   * Token metadata composition (design.md §5.2): native check, then
   * token-mappings resolution (best-effort) + on-chain `ERC20.getMetadata()`
   * reads. Output shape matches the UI's existing `TokenMetadata` contract.
   */
  async getTokenMetadata(
    tokenAddress: string,
    networkId: number
  ): Promise<AggkitTokenMetadata> {
    // L1 (networkId 0) has no dedicated aggkit instance — route through a
    // configured L2 instance, same as `getClaimInputs` (design.md §0.1).
    const client = this.clientForNetworkOrL1(networkId);
    // TODO(aggkit-migration): `getChainByNetworkId` returns the first
    // insertion-order match, and Ethereum mainnet is pre-seeded at networkId 0
    // ahead of any other networkId-0 chain (e.g. a devnet L1). For NATIVE token
    // metadata on networkId 0 this reports mainnet's nativeCurrency/rpcUrl
    // rather than the intended chain. ERC20 metadata is read on-chain and is
    // unaffected in practice; only L1 NATIVE is impacted. See handoff-sdk.md
    // §3.2 / RELEASE.md residual risk #5.
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

  /** Runs the four fan-out calls (§2.1 A-D) for a single configured network. */
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
   * Joins one bridge row into a UI `Transaction`, deriving `status` per the
   * §3 state machine: Tier 1 (claims-set membership, free/batch) first, then
   * Tier 2 (`/l1-info-tree-index` probe, bounded to unclaimed rows only).
   *
   * The Tier-2 probe is keyed by `recordingNetworkId` — the network whose
   * local exit tree actually recorded this deposit (call A vs call B of
   * `fetchNetworkFanout`, see `FetchedBridgeRow`) — NOT `bridge.origin_network`.
   * These coincide for genuine L1-origin deposits and genuine L2-origin
   * tokens, but diverge for withdrawals of an L2's native gas token (design.md
   * §3, "third case"), where `origin_network` is always 0 but the deposit is
   * recorded on the L2's own tree.
   */
  private async toTransaction(
    bridge: AggkitBridge,
    sourceInstanceNetworkId: number,
    recordingNetworkId: number,
    claimsByNetwork: Map<number, Map<string, AggkitClaim>>
  ): Promise<AggkitTransaction> {
    const destinationClaims = claimsByNetwork.get(bridge.destination_network);
    let matchedClaim = destinationClaims?.get(bridge.global_index);

    let status: AggkitTransactionStatus;
    let leafIndexForProof: number | undefined;

    if (matchedClaim) {
      status = 'CLAIMED';
    } else {
      const client = this.clientFor(sourceInstanceNetworkId);
      const probe = await client.getL1InfoTreeIndex({
        networkId: recordingNetworkId,
        depositCount: bridge.deposit_count,
      });

      if (probe !== null) {
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
        } else {
          status = 'READY_TO_CLAIM';
          leafIndexForProof = probe;
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
      // Display counterpart of the S6b status-derivation fix (design.md
      // §3.4a): use the RECORDING network, not `bridge.origin_network`. For
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
