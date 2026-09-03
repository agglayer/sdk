/**
 * AggkitBridgeAggregator
 *
 * Multi-network composition over one `AggkitBridgeClient` per configured L2
 * network: cross-network activity (a thin passthrough to aggkit's
 * bridgetracker `/tracker/v1/activity` endpoint, which does its own
 * server-side fan-out — see `getActivity`), claim-input orchestration, and
 * token-metadata composition.
 */

import { AggkitBridgeClient } from './client';
import { chainRegistry } from '../native/chains/registry';
import { ERC20 } from '../native';
import { ZERO_ADDRESS } from '../constants';
import type {
  AggkitActivityResult,
  AggkitAggregatorConfig,
  AggkitClaimInputsParams,
  AggkitClaimInputsResult,
  AggkitNotReadyReason,
  AggkitTokenMetadata,
  AggkitTrackingData,
} from './types';

function isNativeTokenAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS.toLowerCase();
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
   * Cross-network activity for `fromAddress` — a thin passthrough to
   * `AggkitBridgeClient.getActivity`, i.e. aggkit's bridgetracker
   * `GET /tracker/v1/activity/from/{from_address}`. That endpoint already
   * fans out server-side across every bridge service the tracker is
   * configured with, so any ONE configured network's client answers this
   * identically — the tracker component itself, not any one bridge-service,
   * owns the cross-network view. Every configured client is tried in order
   * (PR #33 review) until one succeeds, so a single temporarily-unreachable
   * instance doesn't fail the call when another configured instance could
   * have answered the identical tracker request; this rejects only once
   * every configured client has failed (or none are configured).
   *
   * REPLACES the client-side `/bridge/v1` fan-out (`getBridges` x2 +
   * `getClaims` x2 per configured network, plus per-row `/l1-info-tree-index`
   * / `/injected-l1-info-leaf` probes) this method used before — see
   * `AggkitActivityResult` in `types.ts` for the full rationale and the
   * resulting contract differences (no pagination, `warnings` instead of
   * `failedNetworks`, a `claimed` tri-state + optional `tracking` instead of
   * the old BRIDGED/LEAF_INCLUDED/READY_TO_CLAIM/CLAIMED derivation). The
   * former ready-to-claim badge (`getReadyToClaimCount`, REMOVED) is now a
   * consumer-side derivation over this same result — filter
   * `claimed !== 'true'` and inspect `tracking`, exactly as this result's
   * `bridges` already has to be interpreted for status display.
   */
  async getActivity(params: {
    fromAddress: string;
    includeTracking?: boolean;
  }): Promise<AggkitActivityResult> {
    const networkIds = this.listNetworkIds();
    if (networkIds.length === 0) {
      throw new Error(
        'AggkitBridgeAggregator.getActivity: no networks configured'
      );
    }

    const failures: Array<{ networkId: number; error: unknown }> = [];
    for (const networkId of networkIds) {
      try {
        return await this.clientFor(networkId).getActivity(params);
      } catch (error) {
        failures.push({ networkId, error });
      }
    }

    // A single configured network propagates its failure as-is (preserving
    // `instanceof AggkitApiError` etc. for callers) — the "all networks
    // failed" summary below only kicks in once there is more than one
    // failure to summarize, since no single error type could represent it.
    const [onlyFailure] = failures;
    if (onlyFailure !== undefined && failures.length === 1) {
      throw onlyFailure.error;
    }

    throw new Error(
      `AggkitBridgeAggregator.getActivity: all configured networks failed: ` +
        failures
          .map(
            ({ networkId, error }) =>
              `${networkId}: ${error instanceof Error ? error.message : String(error)}`
          )
          .join('; ')
    );
  }

  /**
   * Resolves the L1-info-tree index that `/claim-proof` must be built against for a
   * deposit landing on `destinationNetworkId`.
   *  - destinationNetworkId === 0  -> { resolved, sourceL1InfoTreeIndex } (no injection step)
   *  - destination client missing  -> { unknown } (caller keeps legacy behaviour)
   *  - 404 "not injected"          -> { not-injected, detail }
   *  - 200                         -> { resolved, leaf.l1_info_tree_index }  // >= source index
   * Probe errors are NOT swallowed here; they propagate so callers can attribute them
   * to a failure of their own.
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
      // An unconfigured destination L2 keeps today's (possibly reverting)
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
          `network builds a proof from the wrong tree (comment 3847422009). Use the ` +
          `deposit's recording network (` +
          `\`AggkitActivityItem.bridge_network_id\` from \`getActivity\`).`
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
      // permanently non-actionable.
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
}
