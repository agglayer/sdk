import { readFileSync } from 'node:fs';
import { http } from 'viem';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AggkitBridgeAggregator } from '../aggregator';
import { AggkitApiError } from '../errors';
import { chainRegistry } from '../../native/chains/registry';

// ---------------------------------------------------------------------------
// viem mock (for the ERC20.getMetadata() on-chain-read branch of
// getTokenMetadata). `readContractImpl` is reassigned per test; the mocked
// `createPublicClient` always delegates to whatever is currently assigned,
// so BaseContract's constructor-time `createPublicClient` call keeps working
// across tests without re-mocking the whole module each time.
// ---------------------------------------------------------------------------
let readContractImpl: (args: {
  functionName: string;
}) => Promise<unknown> = () =>
  Promise.reject(new Error('readContractImpl not configured'));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: (args: { functionName: string }) => readContractImpl(args),
    })),
    // Spied (not replaced) so `BaseContract`'s `http(config.rpcUrl)` call
    // stays observable — used to prove which RPC URL a chain lookup fed
    // into the transport, without changing any transport behavior (the
    // `createPublicClient` mock above ignores the transport it's given
    // anyway).
    http: vi.fn((url?: string) => actual.http(url)),
  };
});

function loadFixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/${name}`, import.meta.url),
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// URL-routed fetch mock. Each configured network gets its own base URL;
// `installRouter` matches on `startsWith(base)` + required substrings so
// concurrent calls to different networks/endpoints (e.g. `getClaimInputs`'s
// probes) resolve independently regardless of Promise.all/allSettled
// ordering. `getActivity`'s own tests live in `activity.test.ts` — it no
// longer fans out across `/bridge/v1` at all (see `AggkitActivityResult`'s
// module doc in `types.ts`).
// ---------------------------------------------------------------------------
interface Rule {
  test: (url: string) => boolean;
  status: number;
  body: string;
}

function includesAll(url: string, subs: string[]): boolean {
  return subs.every((s) => url.includes(s));
}

function rule(
  base: string,
  subs: string[],
  status: number,
  body: string
): Rule {
  return {
    test: (url) => url.startsWith(base) && includesAll(url, subs),
    status,
    body,
  };
}

function installRouter(rules: Rule[]): void {
  global.fetch = vi.fn(async (url: string) => {
    const matched = rules.find((r) => r.test(url));
    if (!matched) {
      // NOTE: deliberately avoids the substrings "fetch"/"network"/"timeout"
      // — `fetchRawText`'s retry heuristic treats those as retryable and
      // would otherwise retry (with backoff) an unmatched-route test bug
      // for several seconds before failing, instead of failing immediately.
      throw new Error(`aggregator.test router: no rule matched URL: ${url}`);
    }
    return new Response(matched.body, { status: matched.status });
  }) as unknown as typeof fetch;
}

function errorBody(message: string): string {
  return JSON.stringify({ error: message });
}

/** Synthetic `/injected-l1-info-leaf` 200 body (shape = AggkitL1InfoTreeLeaf). */
function injectedLeafBody(l1InfoTreeIndex: number): string {
  return JSON.stringify({
    block_num: 1,
    block_pos: 0,
    l1_info_tree_index: l1InfoTreeIndex,
    previous_block_hash: '0xprevhash',
    timestamp: 1000,
    mainnet_exit_root: '0xmainnetexitroot',
    rollup_exit_root: '0xrollupexitroot',
    global_exit_root: '0xglobalexitroot',
    hash: '0xhash',
  });
}

const BASE_1 = 'http://127.0.0.1:30001';
const BASE_2 = 'http://127.0.0.1:30002';
const BASE_3 = 'http://127.0.0.1:30003';

describe('AggkitBridgeAggregator', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  describe('clientFor / listNetworkIds', () => {
    it('exposes configured network ids and clients', () => {
      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });
      expect(aggregator.listNetworkIds().sort()).toEqual([1, 2]);
      expect(aggregator.clientFor(1).networkId).toBe(1);
    });

    it('throws when asked for an unconfigured network', () => {
      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      expect(() => aggregator.clientFor(99)).toThrow(/no client configured/);
    });
  });

  describe('getClaimInputs', () => {
    it('L1 -> L2: uses the DESTINATION network client with network_id=0 (recording network = L1) for both calls, and builds /claim-proof on the destination-injected index', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=1'],
          200,
          loadFixture('l1_info_tree_index_valid.json')
        ),
        // destinationNetworkId=1 (L2) -> the gate applies; injected exactly
        // at the source index in this test (no S2-style skip).
        rule(
          BASE_1,
          ['/injected-l1-info-leaf', 'network_id=1', 'leaf_index=1'],
          200,
          injectedLeafBody(1)
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=0', 'leaf_index=1', 'deposit_count=1'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 0,
        destinationNetworkId: 1,
        depositCount: 1,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.leafIndex).toBe(1);
      expect(result.sourceL1InfoTreeIndex).toBe(1);
      expect(result.proof.l1_info_tree_leaf.l1_info_tree_index).toBe(1);
    });

    it('getClaimInputs uses the INJECTED index M > N for /claim-proof (synthetic M=3/N=2, mirroring a live enclave case)', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=2'],
          200,
          '2'
        ),
        // Injection skipped ahead: first injected leaf at-or-after N=2 is M=3
        // (mirrors the live case where a claim built on the deposit's own index 2
        // reverted GlobalExitRootInvalid and only succeeded on injected index 3).
        rule(
          BASE_1,
          ['/injected-l1-info-leaf', 'network_id=1', 'leaf_index=2'],
          200,
          injectedLeafBody(3)
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=0', 'leaf_index=3', 'deposit_count=2'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 0,
        destinationNetworkId: 1,
        depositCount: 2,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.sourceL1InfoTreeIndex).toBe(2);
      expect(result.leafIndex).toBe(3);
    });

    it("returns { claimable: false, reason: 'DESTINATION_GER_NOT_INJECTED' } — NOT a throw — while the destination has not injected the GER yet (comments 3847523270 / 3847600104)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
          404,
          loadFixture('l2l2_165338016Z_injected_l1_info_leaf_7.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 2,
        depositCount: 2,
      });

      // The old fabricated `AggkitApiError(httpStatus: 404)` claimed a server
      // error for a request that succeeded; the answer was simply "not yet".
      expect(result).toEqual({
        claimable: false,
        reason: 'DESTINATION_GER_NOT_INJECTED',
        detail: expect.any(String),
        sourceL1InfoTreeIndex: 7,
      });
      // aggkit's own wording is propagated, not re-fabricated.
      expect(result.claimable).toBe(false);
      if (!result.claimable) {
        expect(result.detail).toMatch(/not injected/);
      }
    });

    it("L2 -> L1: a not-yet-settled source returns { claimable: false, reason: 'SOURCE_NOT_ON_L1_INFO_TREE' } from the RECORDING network's client, without throwing (comment 3847523270)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=0'],
          404,
          loadFixture('l1_info_tree_index_notfound_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 0,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'SOURCE_NOT_ON_L1_INFO_TREE',
        detail: expect.stringContaining(
          'not been included on the L1 Info Tree'
        ),
      });
      // No `/claim-proof` request is made once the source is known not-ready.
      const calls = (global.fetch as Mock).mock.calls as [string][];
      expect(
        calls.filter(([url]) => url.includes('/claim-proof'))
      ).toHaveLength(0);
      // The probe went to the recording network (1), keyed by network_id=1.
      expect(
        calls.filter(
          ([url]) =>
            url.startsWith(BASE_1) &&
            url.includes('/l1-info-tree-index') &&
            url.includes('network_id=1')
        )
      ).toHaveLength(1);
    });

    it('L2 -> L1: rc6 wire shape — a 404 with the fixed "is not available yet, retry later" prefix ALSO returns { claimable: false, reason: \'SOURCE_NOT_ON_L1_INFO_TREE\' } (aggkit #1794 / v0.11.0-rc6, comment 3862896539)', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=0'],
          404,
          loadFixture('l1_info_tree_index_rc6_not_available_404.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 0,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'SOURCE_NOT_ON_L1_INFO_TREE',
        detail: expect.stringContaining('is not available yet, retry later'),
      });
    });

    it("L2 -> L1: the aggkit-proxy's OWN routing-failure 404 on /l1-info-tree-index throws — NEVER silently classifies as not-ready — even though 404 is now a recognised not-ready carrier for this endpoint (the proxy-prose trap, comment 3862896539)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=0'],
          404,
          loadFixture('error_404_unknown_network.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      await expect(
        aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 0,
          depositCount: 0,
        })
      ).rejects.toMatchObject({
        httpStatus: 404,
        message: expect.stringContaining('bridge service url not found'),
      });
    });

    it("L2 -> L1: rc6 syncer-inconsistent 503 (a syncer is halted resolving a reorg) returns { claimable: false, reason: 'SYNCER_INCONSISTENT' } — NOT a throw — rather than flooding failedNetworks for every in-flight deposit during an ordinary reorg (v0.11.0-rc6, comment 3862896539)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=0'],
          503,
          loadFixture('l1_info_tree_index_rc6_syncer_inconsistent_503.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 0,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'SYNCER_INCONSISTENT',
        detail: expect.stringContaining('a syncer is temporarily inconsistent'),
      });
    });

    it('L2 -> L1: rc4/rc5\'s bare "not found" 500 carrier THROWS AggkitApiError end-to-end — rc4/rc5 are NOT a supported aggkit target, so this rc4/rc5-shaped body is a genuine fault on the supported v0.11.0-rc6+ floor (l1_info_tree_index_network1_error.json, live-captured; supersedes audit finding C1 / commit 60d7407)', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=0'],
          500,
          loadFixture('l1_info_tree_index_network1_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      await expect(
        aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 0,
          depositCount: 0,
        })
      ).rejects.toMatchObject({
        httpStatus: 500,
        message: expect.stringContaining('error: not found'),
      });
    });

    it("L2 -> L2: rc6's /injected-l1-info-leaf 404 \"l1infotreesync has not indexed l1 info tree leaf index N yet (already injected on L2 per l2gersync)\" returns { claimable: false, reason: 'L1_INFO_LEAF_NOT_INDEXED' } — NOT a throw (audit finding C2)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
          404,
          loadFixture('injected_l1_info_leaf_rc6_leaf_not_indexed_404.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 2,
        depositCount: 2,
      });

      // The union member is DISTINCT from DESTINATION_GER_NOT_INJECTED: the wire
      // says the GER IS already injected on L2; only the L1-side index lags.
      expect(result).toEqual({
        claimable: false,
        reason: 'L1_INFO_LEAF_NOT_INDEXED',
        detail: expect.stringContaining(
          'has not indexed l1 info tree leaf index'
        ),
        sourceL1InfoTreeIndex: 7,
      });
    });

    it("L2 -> L2: rc6's /injected-l1-info-leaf 503 returns { claimable: false, reason: 'SYNCER_INCONSISTENT' } — NOT a throw — so an ordinary destination-side reorg does not flood failedNetworks (audit finding C2)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
          503,
          loadFixture('injected_l1_info_leaf_rc6_syncer_inconsistent_503.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 2,
        depositCount: 2,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'SYNCER_INCONSISTENT',
        detail: expect.stringContaining('a syncer is temporarily inconsistent'),
        sourceL1InfoTreeIndex: 7,
      });
    });

    it('L2 -> L2: a GENUINE 500 on /injected-l1-info-leaf still throws AggkitApiError (the C2 widening is 404/prose-gated 503 only)', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
          500,
          errorBody(
            'failed to get injected global exit root for leaf index=7, error: database is locked'
          )
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      await expect(
        aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 2,
          depositCount: 2,
        })
      ).rejects.toMatchObject({ httpStatus: 500 });
    });

    it("L2 -> L2: rc6's /claim-proof 404 (source settled, destination injected, a syncer a few blocks behind on the leaf) returns { claimable: false, reason: 'CLAIM_PROOF_NOT_AVAILABLE', sourceL1InfoTreeIndex } — NOT a throw. Activates the not-ready arm design 2.2/2.6 reserved (audit finding C3)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
          200,
          injectedLeafBody(7)
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=7', 'deposit_count=2'],
          404,
          loadFixture('claim_proof_rc6_bridgesync_l2_not_indexed_404.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 2,
        depositCount: 2,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'CLAIM_PROOF_NOT_AVAILABLE',
        detail: expect.stringContaining('has not indexed deposit count'),
        sourceL1InfoTreeIndex: 7,
      });
    });

    it("L2 -> L1: rc6's /claim-proof 503 returns { claimable: false, reason: 'SYNCER_INCONSISTENT' } — NOT a throw (audit finding C3)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=3'],
          200,
          loadFixture('l2l1_lifecycle_l1_info_tree_index_ready.json')
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=7', 'deposit_count=3'],
          503,
          loadFixture('claim_proof_rc6_syncer_inconsistent_503.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 3,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'SYNCER_INCONSISTENT',
        detail: expect.stringContaining('a syncer is temporarily inconsistent'),
        sourceL1InfoTreeIndex: 7,
      });
    });

    // The prose gate on /claim-proof's 503 is load-bearing: ClaimProofHandler has
    // two 503 sources that are genuine configuration faults, in rc5 AND rc6+.
    it.each([
      [
        'L1 bridge syncer is not available',
        'claim_proof_l1_bridge_syncer_unavailable_503.json',
      ],
      [
        'L2 bridge syncer is not available',
        'claim_proof_l2_bridge_syncer_unavailable_503.json',
      ],
    ])(
      'L2 -> L1: /claim-proof\'s GENUINE-FAULT 503 "%s" still throws AggkitApiError — a misconfigured aggkit must never be read as "keep polling forever" (audit finding C3)',
      async (message, fixture) => {
        installRouter([
          rule(
            BASE_1,
            ['/l1-info-tree-index', 'network_id=1', 'deposit_count=3'],
            200,
            loadFixture('l2l1_lifecycle_l1_info_tree_index_ready.json')
          ),
          rule(
            BASE_1,
            ['/claim-proof', 'network_id=1', 'leaf_index=7', 'deposit_count=3'],
            503,
            loadFixture(fixture)
          ),
        ]);

        const aggregator = new AggkitBridgeAggregator({
          networks: { 1: BASE_1 },
        });

        await expect(
          aggregator.getClaimInputs({
            recordingNetworkId: 1,
            destinationNetworkId: 0,
            depositCount: 3,
          })
        ).rejects.toMatchObject({ httpStatus: 503, message });
      }
    );

    it("L2 -> L1: the aggkit-proxy's OWN routing-failure 404 on /claim-proof throws — never classified as CLAIM_PROOF_NOT_AVAILABLE (the proxy-prose trap, now that 404 is a not-ready carrier on this endpoint too)", async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=3'],
          200,
          loadFixture('l2l1_lifecycle_l1_info_tree_index_ready.json')
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=7', 'deposit_count=3'],
          404,
          loadFixture('error_404_unknown_network.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      await expect(
        aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 0,
          depositCount: 3,
        })
      ).rejects.toMatchObject({
        httpStatus: 404,
        message: expect.stringContaining('bridge service url not found'),
      });
    });

    it('L2 -> L1 (destination 0) skips Tier-2b entirely: no /injected-l1-info-leaf request is made', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=3'],
          200,
          loadFixture('l2l1_lifecycle_l1_info_tree_index_ready.json')
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=7', 'deposit_count=3'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
        // If the gate wrongly fires for destination 0, this unmatched
        // /injected-l1-info-leaf request throws immediately (router has no
        // rule for it) instead of silently succeeding.
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 3,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.sourceL1InfoTreeIndex).toBe(7);
      expect(result.leafIndex).toBe(7);
      const calls = (global.fetch as Mock).mock.calls as [string][];
      const injectedLeafCalls = calls.filter(([url]) =>
        url.includes('/injected-l1-info-leaf')
      );
      expect(injectedLeafCalls).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Recording-network routing regressions (comment 3847422009).
    // These deliberately route ONLY the recording-network URLs: the router
    // throws `no rule matched URL` for anything else, so the pre-fix code
    // (which keyed both endpoints off `bridge.origin_network`) fails loudly
    // here instead of silently building a proof from the wrong tree.
    // -----------------------------------------------------------------------

    it('L2-1 -> L2-2 NATIVE GAS TOKEN (origin_network=0, recorded on L2-1): builds the proof from the RECORDING network (1), never from network 0 (comment 3847422009)', async () => {
      installRouter([
        // ONLY network_id=1 is routed. A request for network_id=0 (what the
        // old origin-keyed routing would issue for origin_network=0) hits the
        // router's no-rule-matched throw.
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=4'],
          200,
          '9'
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=9'],
          200,
          injectedLeafBody(9)
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=9', 'deposit_count=4'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        // retries: 0 so a routing regression surfaces as the router's
        // `no rule matched URL: ...network_id=0...` message immediately,
        // rather than as a 5s vitest timeout (fetchRawText's retry heuristic
        // treats any error message containing "network" as retryable, and the
        // unrouted URL contains `network_id`).
        networks: { 1: BASE_1, 2: BASE_2 },
        retries: 0,
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 2,
        depositCount: 4,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.sourceL1InfoTreeIndex).toBe(9);
      expect(result.leafIndex).toBe(9);

      const calls = (global.fetch as Mock).mock.calls as [string][];
      // Neither tree-relative endpoint may ever be asked about network 0.
      const networkZeroTreeCalls = calls.filter(
        ([url]) =>
          url.includes('network_id=0') &&
          (url.includes('/l1-info-tree-index') || url.includes('/claim-proof'))
      );
      expect(networkZeroTreeCalls).toHaveLength(0);
      // Both tree-relative endpoints used the SAME recording network.
      expect(
        calls.filter(
          ([url]) =>
            url.includes('/l1-info-tree-index') && url.includes('network_id=1')
        )
      ).toHaveLength(1);
      expect(
        calls.filter(
          ([url]) =>
            url.includes('/claim-proof') && url.includes('network_id=1')
        )
      ).toHaveLength(1);
    });

    it('L2-1 -> L2-2 of a THIRD-NETWORK-ORIGIN token (origin_network=3, recorded on L2-1): builds the proof from the RECORDING network (1), never from network 3 (audit finding P2 — Case C)', async () => {
      // Case C from the design/audit's four-routing-cases table: a token
      // whose origin is a THIRD network (3), distinct from both the
      // recording network (1, where the bridging tx executed) and the
      // destination (2). `getClaimInputs` has no `origin_network` parameter
      // at all (it was removed — comment 3847422009), so there is nothing
      // in this call for a reintroduced origin-keyed shortcut to read except
      // by routing through a hypothetical `clientFor(3)`. Network 3 is
      // CONFIGURED (so `clientFor(3)` would successfully resolve a client,
      // not throw "no client configured") but deliberately left UNROUTED —
      // same technique as the case-D test above — so any request that ever
      // targets it fails immediately with "no rule matched" rather than
      // masking the regression behind a differently-worded config error.
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=7'],
          200,
          '10'
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=10'],
          200,
          injectedLeafBody(12)
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=12', 'deposit_count=7'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        // retries: 0 — see the case-D test above: a routing regression must
        // surface immediately as "no rule matched", not a 5s vitest timeout.
        networks: { 1: BASE_1, 2: BASE_2, 3: BASE_3 },
        retries: 0,
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 2,
        depositCount: 7,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.sourceL1InfoTreeIndex).toBe(10);
      expect(result.leafIndex).toBe(12);

      const calls = (global.fetch as Mock).mock.calls as [string][];
      // Neither tree-relative endpoint may ever be asked about network 3
      // (the notional origin) or network 0.
      const wrongNetworkTreeCalls = calls.filter(
        ([url]) =>
          (url.includes('network_id=3') || url.includes('network_id=0')) &&
          (url.includes('/l1-info-tree-index') || url.includes('/claim-proof'))
      );
      expect(wrongNetworkTreeCalls).toHaveLength(0);
      // No request of any kind was sent to network 3's instance.
      expect(calls.some(([url]) => url.startsWith(BASE_3))).toBe(false);
      // Both tree-relative endpoints used the SAME recording network.
      expect(
        calls.filter(
          ([url]) =>
            url.includes('/l1-info-tree-index') && url.includes('network_id=1')
        )
      ).toHaveLength(1);
      expect(
        calls.filter(
          ([url]) =>
            url.includes('/claim-proof') && url.includes('network_id=1')
        )
      ).toHaveLength(1);
    });

    it('L2-1 -> L1 NATIVE GAS TOKEN (origin_network=0, destination 0): no "no client configured for network 0" — routes to the recording network 1 (comment 3847422009)', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=6'],
          200,
          '11'
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=11', 'deposit_count=6'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 6,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.sourceL1InfoTreeIndex).toBe(11);
      expect(result.leafIndex).toBe(11);
    });

    it('L1 -> L2-2 of an L2-1-ORIGIN token (origin_network=1, recorded on L1): probes network_id=0 and never touches L2-1 (comment 3847422009)', async () => {
      installRouter([
        // Only network_id=0 is routed for the tree endpoints. The old
        // origin-keyed routing would have used clientFor(1) with
        // network_id=1 -> a well-formed proof from L2-1's tree.
        rule(
          BASE_2,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=8'],
          200,
          '5'
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=5'],
          200,
          injectedLeafBody(5)
        ),
        rule(
          BASE_2,
          ['/claim-proof', 'network_id=0', 'leaf_index=5', 'deposit_count=8'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        // retries: 0 — see the case-D test above.
        networks: { 1: BASE_1, 2: BASE_2 },
        retries: 0,
      });

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 0,
        destinationNetworkId: 2,
        depositCount: 8,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.leafIndex).toBe(5);
      const calls = (global.fetch as Mock).mock.calls as [string][];
      expect(calls.every(([url]) => url.startsWith(BASE_2))).toBe(true);
    });

    it('recordingNetworkId=0 with an UNCONFIGURED destination falls back to any configured instance instead of throwing', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=1'],
          200,
          '2'
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=0', 'leaf_index=2', 'deposit_count=1'],
          200,
          loadFixture('claim_proof_valid.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      // destination 7 is unconfigured -> resolveInjectedLeafIndex returns
      // { kind: 'unknown' } and the proof is built on the source index.
      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 0,
        destinationNetworkId: 7,
        depositCount: 1,
      });
      expect(result.claimable).toBe(true);
      if (!result.claimable) {
        throw new Error(
          `expected claimable: true, got ${result.reason}: ${result.detail}`
        );
      }

      expect(result.leafIndex).toBe(2);
      expect(result.sourceL1InfoTreeIndex).toBe(2);
    });

    it("throws a migration Error when a JS caller passes the removed 'originNetworkId' (comment 3847422009)", async () => {
      installRouter([]);
      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      await expect(
        aggregator.getClaimInputs({
          // Simulating an un-typechecked JavaScript caller that was not
          // migrated: `originNetworkId?: never` gives it no protection.
          originNetworkId: 1,
          destinationNetworkId: 0,
          depositCount: 0,
        } as unknown as Parameters<AggkitBridgeAggregator['getClaimInputs']>[0])
      ).rejects.toThrow(/'originNetworkId' was removed/);
    });

    it('still throws AggkitApiError for a GENUINE /l1-info-tree-index 500 whose body does not match the not-ready patterns (comment 3847600104)', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=0'],
          500,
          errorBody('unexpected internal database failure')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      let caught: unknown;
      try {
        await aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 0,
          depositCount: 0,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggkitApiError);
      expect((caught as AggkitApiError).httpStatus).toBe(500);
      expect((caught as AggkitApiError).endpoint).toBe('/l1-info-tree-index');
    });

    it('still throws AggkitApiError for a genuine /claim-proof 500 (claim_proof_error_badindex.json) — the union has no reachable not-ready arm there yet', async () => {
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=1'],
          200,
          '4'
        ),
        rule(
          BASE_1,
          ['/claim-proof', 'network_id=1', 'leaf_index=4', 'deposit_count=1'],
          500,
          loadFixture('claim_proof_error_badindex.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      await expect(
        aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 0,
          depositCount: 1,
        })
      ).rejects.toBeInstanceOf(AggkitApiError);
    });

    it("throws an informative error naming BOTH indices when aggkit returns an injected leaf LOWER than the deposit's own source index (comment 3862897612)", async () => {
      // Contract violation: `getInjectedL1InfoLeaf` is documented to return
      // result.l1_info_tree_index >= leafIndex for an L2 destination -- here
      // it returns 3, lower than the source index (10) that was requested.
      installRouter([
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=5'],
          200,
          '10'
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=10'],
          200,
          injectedLeafBody(3)
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      let caught: unknown;
      try {
        await aggregator.getClaimInputs({
          recordingNetworkId: 1,
          destinationNetworkId: 2,
          depositCount: 5,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // A genuine backend-contract violation is a real error, not a
      // not-ready state: it must stay a plain `Error` throw and must NOT be
      // downgraded to a `claimable: false` reason, which would turn a
      // funds-relevant backend bug into "keep polling forever".
      // `AggkitApiError` is reserved for real non-2xx/transport failures.
      expect(caught).not.toBeInstanceOf(AggkitApiError);
      expect((caught as Error).message).toContain('10');
      expect((caught as Error).message).toContain('3');
    });
  });

  describe('getTokenMetadata', () => {
    const NATIVE_NETWORK_ID = 700;

    beforeEach(() => {
      chainRegistry.registerChain({
        chainId: 700700,
        networkId: NATIVE_NETWORK_ID,
        name: 'Test Native Chain',
        rpcUrl: 'http://unused-rpc.test',
        nativeCurrency: { name: 'Test Ether', symbol: 'tETH', decimals: 18 },
      });
    });

    it('native branch: returns the chain nativeCurrency for the zero address', async () => {
      const aggregator = new AggkitBridgeAggregator({
        networks: { [NATIVE_NETWORK_ID]: BASE_1 },
      });

      const metadata = await aggregator.getTokenMetadata(
        '0x0000000000000000000000000000000000000000',
        NATIVE_NETWORK_ID
      );

      expect(metadata).toEqual({
        name: 'Test Ether',
        symbol: 'tETH',
        decimals: 18,
        tokenAddress: '0x0000000000000000000000000000000000000000',
        network: NATIVE_NETWORK_ID,
      });
      // No aggkit HTTP call should happen for the native short-circuit.
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('ERC20 branch: composes token-mappings + on-chain reads into the UI TokenMetadata shape', async () => {
      const ERC20_NETWORK_ID = 701;
      const TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111';

      chainRegistry.registerChain({
        chainId: 701701,
        networkId: ERC20_NETWORK_ID,
        name: 'Test ERC20 Chain',
        rpcUrl: 'http://unused-rpc.test',
        nativeCurrency: { name: 'Test Ether', symbol: 'tETH', decimals: 18 },
      });

      readContractImpl = (args) => {
        switch (args.functionName) {
          case 'name':
            return Promise.resolve('Test Token');
          case 'symbol':
            return Promise.resolve('TST');
          case 'decimals':
            return Promise.resolve(6);
          case 'totalSupply':
            return Promise.resolve(1_000_000n);
          default:
            return Promise.reject(
              new Error(`unexpected call: ${args.functionName}`)
            );
        }
      };

      installRouter([
        rule(
          BASE_1,
          ['/token-mappings', `network_id=${ERC20_NETWORK_ID}`],
          200,
          JSON.stringify({
            token_mappings: [
              {
                block_num: 1,
                block_pos: 0,
                block_timestamp: 1,
                tx_hash: '0xmap',
                origin_network: 0,
                origin_token_address: TOKEN_ADDRESS,
                wrapped_token_address: '0xwrapped',
                metadata: '0x',
                is_not_mintable: false,
                token_type: 1,
              },
            ],
            count: 1,
          })
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { [ERC20_NETWORK_ID]: BASE_1 },
      });

      const metadata = await aggregator.getTokenMetadata(
        TOKEN_ADDRESS,
        ERC20_NETWORK_ID
      );

      expect(metadata.name).toBe('Test Token');
      expect(metadata.symbol).toBe('TST');
      expect(metadata.decimals).toBe(6);
      expect(metadata.totalSupply).toBe('1000000');
      expect(metadata.tokenAddress).toBe(TOKEN_ADDRESS);
      expect(metadata.originTokenAddress).toBe(TOKEN_ADDRESS);
      expect(metadata.originTokenNetwork).toBe(0);
      expect(metadata.wrappedTokenAddressV1).toBe('0xwrapped');
    });

    it('L1-origin (networkId 0) lookup routes through a configured L2 instance instead of throwing (regression, bug c)', async () => {
      // Regression (bug c, found during manual validation): getTokenMetadata()
      // used to call `this.clientFor(networkId)` directly, which throws "no
      // client configured for network 0" when only L2 instances are
      // configured — L1 has no dedicated aggkit instance. This mirrors
      // the L1 routing `getClaimInputs` already implements: any configured
      // L2 instance's embedded L1 syncer serves `network_id=0` queries.
      const TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222';

      readContractImpl = (args) => {
        switch (args.functionName) {
          case 'name':
            return Promise.resolve('L1 Test Token');
          case 'symbol':
            return Promise.resolve('L1T');
          case 'decimals':
            return Promise.resolve(18);
          case 'totalSupply':
            return Promise.resolve(500n);
          default:
            return Promise.reject(
              new Error(`unexpected call: ${args.functionName}`)
            );
        }
      };

      installRouter([
        rule(
          BASE_1,
          [
            '/token-mappings',
            'network_id=0',
            `origin_token_address=${TOKEN_ADDRESS}`,
          ],
          200,
          JSON.stringify({ token_mappings: [], count: 0 })
        ),
      ]);

      // Only network 1 (an L2) is configured — no "network 0" client exists;
      // L1 data is always served via an L2 instance's embedded L1 syncer.
      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const metadata = await aggregator.getTokenMetadata(TOKEN_ADDRESS, 0);

      expect(metadata.name).toBe('L1 Test Token');
      expect(metadata.symbol).toBe('L1T');
      expect(metadata.decimals).toBe(18);
      expect(metadata.tokenAddress).toBe(TOKEN_ADDRESS);
      expect(metadata.network).toBe(0);
    });

    it('networkId-0 collision: a registered devnet L1 wins over the default Ethereum mainnet chain — no request is ever constructed toward eth.llamarpc.com', async () => {
      // Reproduces a previously-dormant consumer scenario:
      // a consumer registers a devnet L1 at networkId 0 (as
      // `agglayer-dev-ui`'s aggLayerSdk.tsx does), then requests metadata
      // for an ERC20 token bridged from that L1 that isn't in the UI's
      // static token list — exercising the on-chain `ERC20.getMetadata()`
      // read path, which is where the collision used to leak the default
      // mainnet chain's rpcUrl (`https://eth.llamarpc.com`) into a real
      // outbound RPC request instead of the devnet's.
      const DEVNET_CHAIN_ID = 900000;
      const DEVNET_RPC = 'http://devnet-l1.internal.test:8545';
      const TOKEN_ADDRESS = '0x3333333333333333333333333333333333333333';

      chainRegistry.registerChain({
        chainId: DEVNET_CHAIN_ID,
        networkId: 0,
        name: 'Devnet L1',
        rpcUrl: DEVNET_RPC,
        nativeCurrency: { name: 'Devnet Ether', symbol: 'dETH', decimals: 18 },
      });

      readContractImpl = (args) => {
        switch (args.functionName) {
          case 'name':
            return Promise.resolve('Devnet Token');
          case 'symbol':
            return Promise.resolve('DVT');
          case 'decimals':
            return Promise.resolve(18);
          case 'totalSupply':
            return Promise.resolve(0n);
          default:
            return Promise.reject(
              new Error(`unexpected call: ${args.functionName}`)
            );
        }
      };

      installRouter([
        rule(
          BASE_1,
          [
            '/token-mappings',
            'network_id=0',
            `origin_token_address=${TOKEN_ADDRESS}`,
          ],
          200,
          JSON.stringify({ token_mappings: [], count: 0 })
        ),
      ]);

      // Ignore any transport calls made by earlier tests in this file —
      // only this test's own RPC-URL usage matters below.
      (http as unknown as Mock).mockClear();

      // Only network 1 (an L2) is configured — L1 (networkId 0) has no
      // dedicated aggkit instance, so this routes through network 1's
      // configured client, same as the L1-origin test above.
      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const metadata = await aggregator.getTokenMetadata(TOKEN_ADDRESS, 0);

      expect(metadata.name).toBe('Devnet Token');
      expect(metadata.symbol).toBe('DVT');
      expect(metadata.network).toBe(0);

      const rpcUrlsRequested = (http as unknown as Mock).mock.calls.map(
        (call) => call[0]
      );
      expect(rpcUrlsRequested).toContain(DEVNET_RPC);
      expect(rpcUrlsRequested).not.toContain('https://eth.llamarpc.com');
    });
  });
});
