import { readFileSync } from 'node:fs';
import { http } from 'viem';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AggkitBridgeAggregator, decodeCursor } from '../aggregator';
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
// concurrent fan-out calls (A/B/C/D, see aggregator.ts fetchNetworkFanout) to different
// networks/endpoints resolve independently regardless of Promise.all/
// allSettled ordering.
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

function bridgesBody(bridges: unknown[], count: number): string {
  return JSON.stringify({ bridges, count });
}

function claimsBody(claims: unknown[], count: number): string {
  return JSON.stringify({ claims, count });
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

/** Minimal synthetic bridge row (small global_index — no BigInt precision concerns). */
function makeBridge(
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    block_num: 1,
    block_pos: 0,
    from_address: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
    tx_hash: '0xhash',
    global_index: 0,
    block_timestamp: 1000,
    leaf_type: 0,
    origin_network: 0,
    origin_address: '0x0000000000000000000000000000000000000000',
    destination_network: 0,
    destination_address: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
    amount: '1',
    metadata: '0x',
    deposit_count: 0,
    bridge_hash: '0xbridgehash',
    txn_sender: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
    to_address: '0xC8cbEBf950B9Df44d987c8619f092beA980fF038',
    ...overrides,
  };
}

/** Generates the 4 fan-out rules (A/B/C/D) for one network. */
function networkRules(
  base: string,
  networkId: number,
  responses: {
    a?: { status: number; body: string };
    b?: { status: number; body: string };
    c?: { status: number; body: string };
    d?: { status: number; body: string };
  }
): Rule[] {
  const empty = bridgesBody([], 0);
  const emptyClaims = claimsBody([], 0);
  const rules: Rule[] = [];

  rules.push(
    rule(
      base,
      ['/bridges', `network_id=${networkId}`],
      responses.a?.status ?? 200,
      responses.a?.body ?? empty
    )
  );
  rules.push(
    rule(
      base,
      ['/bridges', 'network_id=0', `network_ids=${networkId}`],
      responses.b?.status ?? 200,
      responses.b?.body ?? empty
    )
  );
  rules.push(
    rule(
      base,
      ['/claims', `network_id=${networkId}`],
      responses.c?.status ?? 200,
      responses.c?.body ?? emptyClaims
    )
  );
  rules.push(
    rule(
      base,
      ['/claims', 'network_id=0'],
      responses.d?.status ?? 200,
      responses.d?.body ?? emptyClaims
    )
  );

  return rules;
}

const BASE_1 = 'http://127.0.0.1:30001';
const BASE_2 = 'http://127.0.0.1:30002';
const ADDRESS = '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE';

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

  describe('getActivity — merge across networks', () => {
    it('merges bridges from 2 networks, sorted by block_timestamp desc, no duplicates', async () => {
      const rowNet1 = makeBridge({
        bridge_hash: '0xnet1row',
        block_timestamp: 100,
        deposit_count: 1,
        global_index: 11,
        origin_network: 1,
        destination_network: 0,
      });
      const rowNet2 = makeBridge({
        bridge_hash: '0xnet2row',
        block_timestamp: 200,
        deposit_count: 2,
        global_index: 22,
        origin_network: 2,
        destination_network: 0,
      });

      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: bridgesBody([rowNet1], 1) },
          d: { status: 200, body: claimsBody([{ global_index: '11' }], 1) },
        }),
        ...networkRules(BASE_2, 2, {
          a: { status: 200, body: bridgesBody([rowNet2], 1) },
          d: { status: 200, body: claimsBody([{ global_index: '22' }], 1) },
        }),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      expect(page.failedNetworks).toEqual([]);
      expect(page.data).toHaveLength(2);
      // net2's row (timestamp 200) sorts before net1's (timestamp 100), desc.
      expect(page.data[0]?.bridgeHash).toBe('0xnet2row');
      expect(page.data[1]?.bridgeHash).toBe('0xnet1row');
      expect(page.data[0]?.status).toBe('CLAIMED');
      expect(page.data[1]?.status).toBe('CLAIMED');
      expect(page.pagination.total).toBe(2);
    });
  });

  describe('getActivity — partial failure', () => {
    it('when 1 of 2 networks 503s, returns the healthy network rows AND reports the failure with its network id', async () => {
      const healthyRow = makeBridge({
        bridge_hash: '0xhealthy',
        block_timestamp: 500,
        deposit_count: 7,
        global_index: 77,
      });

      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: bridgesBody([healthyRow], 1) },
          d: { status: 200, body: claimsBody([{ global_index: '77' }], 1) },
        }),
        // Network 2 is entirely down: every endpoint 503s.
        rule(
          BASE_2,
          ['/bridges'],
          503,
          errorBody('L1/L2 bridge syncer is not available')
        ),
        rule(
          BASE_2,
          ['/claims'],
          503,
          errorBody('L1/L2 bridge syncer is not available')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.bridgeHash).toBe('0xhealthy');

      expect(page.failedNetworks).toHaveLength(1);
      expect(page.failedNetworks[0]?.networkId).toBe(2);
      expect(page.failedNetworks[0]?.httpStatus).toBe(503);
    });

    it('rejects when ALL configured networks fail', async () => {
      installRouter([
        rule(BASE_1, ['/bridges'], 503, errorBody('down')),
        rule(BASE_1, ['/claims'], 503, errorBody('down')),
        rule(BASE_2, ['/bridges'], 503, errorBody('down')),
        rule(BASE_2, ['/claims'], 503, errorBody('down')),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      await expect(
        aggregator.getActivity({ fromAddress: ADDRESS })
      ).rejects.toThrow(/all configured networks failed/);
    });
  });

  describe('decodeCursor — junk-value coercion (comment 3862897288)', () => {
    it('accepts ONLY a non-negative-integer number or a digits-only string, dropping every other value entirely (key absent from the result, not merely non-junk)', () => {
      // Each entry is decoded independently (decodeCursor has no
      // cross-key dependency), so a single object can exercise the full
      // accept/reject matrix in one call.
      const cursor = JSON.stringify({
        'junk:null': null,
        'junk:emptyString': '',
        'junk:emptyArray': [],
        'junk:false': false,
        'junk:true': true,
        'junk:trailingLetters': '3abc',
        'junk:exponent': '1e3',
        'junk:negativeNumber': -1,
        'junk:negativeString': '-1',
        'junk:fraction': 1.5,
        'junk:hexPrefix': '0x3',
        'junk:whitespacePadded': ' 3 ',
        'junk:object': { nested: 1 },
        'valid:zero': 0,
        'valid:zeroString': '0',
        'valid:three': '3',
        'valid:threeNumber': 3,
      });

      const decoded = decodeCursor(cursor);

      // Every junk key must be ABSENT -- not present-with-some-fallback.
      for (const junkKey of [
        'junk:null',
        'junk:emptyString',
        'junk:emptyArray',
        'junk:false',
        'junk:true',
        'junk:trailingLetters',
        'junk:exponent',
        'junk:negativeNumber',
        'junk:negativeString',
        'junk:fraction',
        'junk:hexPrefix',
        'junk:whitespacePadded',
        'junk:object',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(decoded, junkKey)).toBe(
          false
        );
      }

      // Legitimate non-negative integers (including the 0 EXHAUSTED
      // sentinel, both as a number and as a digits-only string) survive.
      expect(decoded['valid:zero']).toBe(0);
      expect(decoded['valid:zeroString']).toBe(0);
      expect(decoded['valid:three']).toBe(3);
      expect(decoded['valid:threeNumber']).toBe(3);

      expect(Object.keys(decoded).sort()).toEqual(
        [
          'valid:zero',
          'valid:zeroString',
          'valid:three',
          'valid:threeNumber',
        ].sort()
      );
    });

    it('drops a value that is unsafe as an integer even though it is digits-only (beyond Number.isSafeInteger)', () => {
      const decoded = decodeCursor(
        JSON.stringify({ 'huge:unsafe': '90071992547409910000' })
      );
      expect(Object.prototype.hasOwnProperty.call(decoded, 'huge:unsafe')).toBe(
        false
      );
    });
  });

  describe('getActivity — decodeCursor junk-value coercion, end-to-end (comment 3862897288)', () => {
    it('drops a non-integer cursor entry (e.g. "abc") as junk, but preserves a legitimate EXHAUSTED (0) entry as a sentinel, not junk', async () => {
      installRouter([
        // Simulates aggkit 400ing on a junk page_number -- if the old code
        // let the cursor's "abc" pass straight through as-is, this rule
        // would be hit instead of the well-formed page_number=1 fallback.
        rule(
          BASE_1,
          ['/bridges', 'network_id=1', 'page_number=abc'],
          400,
          errorBody('page_number must be a number')
        ),
        // If EXHAUSTED (0) were wrongly coerced away as "not a positive
        // integer", this call would be wrongly re-requested at page 1 and
        // 400 here.
        rule(
          BASE_1,
          ['/claims', 'network_id=1', 'page_number=1'],
          400,
          errorBody('should not be re-requested: call is EXHAUSTED')
        ),
        ...networkRules(BASE_1, 1, {}),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });

      const cursor = JSON.stringify({
        '1:bridgesOrigin': 'abc', // junk -> dropped -> defaults to page 1
        '1:claimsHere': 0, // EXHAUSTED sentinel -> preserved -> call skipped
      });
      const page = await aggregator.getActivity({
        fromAddress: ADDRESS,
        cursor,
      });

      expect(page.failedNetworks).toEqual([]);
      expect(page.data).toEqual([]);

      // The EXHAUSTED claimsHere call was skipped entirely -- no request to
      // /claims?network_id=1 was made at all.
      const calls = (global.fetch as Mock).mock.calls as [string][];
      const claimsHereCalls = calls.filter(
        ([url]) => url.includes('/claims') && url.includes('network_id=1')
      );
      expect(claimsHereCalls).toHaveLength(0);
    });
  });

  describe('getActivity — empty networks guard (comment 3862897421)', () => {
    it('rejects instead of silently returning an empty page when no networks are configured', async () => {
      const aggregator = new AggkitBridgeAggregator({ networks: {} });

      await expect(
        aggregator.getActivity({ fromAddress: ADDRESS })
      ).rejects.toThrow(/no networks configured/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('getActivity — status derivation: L1 -> L2 (fixture-backed)', () => {
    // bridges_network0.json (B call: L1-origin destined to network 1) has 6
    // rows; deposit_count=1 <-> global_index 18446744073709551617.
    const TARGET_GLOBAL_INDEX = '18446744073709551617';

    it('CLAIMED: global_index present in destination claims set (claims_network1.json)', async () => {
      installRouter([
        ...networkRules(BASE_1, 1, {
          b: { status: 200, body: loadFixture('bridges_network0.json') },
          c: { status: 200, body: loadFixture('claims_network1.json') },
        }),
        // bridges_network0.json's 6th row (deposit_count=0, destined to
        // network 7) isn't in claims_network1's set (destined to 1) and so
        // falls through to a Tier-2 probe; not the row under test here, but
        // still needs a rule or the client's retry loop stalls the test.
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_notfound_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('CLAIMED');
      expect(row?.claimTransactionHash).toBeDefined();
    });

    it('BRIDGED: not claimed AND l1-info-tree-index probe 500s (l1_info_tree_index_notfound_error.json)', async () => {
      installRouter([
        ...networkRules(BASE_1, 1, {
          b: { status: 200, body: loadFixture('bridges_network0.json') },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_notfound_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('BRIDGED');
      expect(row?.leafIndexForProof).toBeUndefined();
    });

    it('READY_TO_CLAIM: not claimed AND l1-info-tree-index probe succeeds (l1_info_tree_index_valid.json)', async () => {
      installRouter([
        ...networkRules(BASE_1, 1, {
          b: { status: 200, body: loadFixture('bridges_network0.json') },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          200,
          loadFixture('l1_info_tree_index_valid.json')
        ),
        // destination_network=1 (L2) -> Tier-2b gate applies.
        // Injected exactly at the source index -> leafIndexForProof unchanged.
        rule(
          BASE_1,
          ['/injected-l1-info-leaf', 'network_id=1', 'leaf_index=1'],
          200,
          injectedLeafBody(1)
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('READY_TO_CLAIM');
      expect(row?.leafIndexForProof).toBe(1);
    });
  });

  describe('getActivity — status derivation: L2 -> L1 (fixture-backed)', () => {
    // bridges_network1.json (A call, origin=network 1) has 3 rows;
    // deposit_count=0 <-> global_index "0".
    const TARGET_GLOBAL_INDEX = '0';

    it('BRIDGED: claims_network0.json is empty (no autoclaim) AND probe 500s (l1_info_tree_index_network1_error.json)', async () => {
      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: loadFixture('bridges_network1.json') },
          d: { status: 200, body: loadFixture('claims_network0.json') },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_network1_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('BRIDGED');
      // C1 REGRESSION GUARD. This assertion is the reason the C1 regression was
      // invisible to CI: `status === 'BRIDGED'` is produced BOTH by the correct
      // not-ready classification and by the throw-then-degrade path, so only
      // `failedNetworks` distinguishes them. rc4/rc5's bare "not found" 500 is a
      // genuine not-ready carrier (see client.ts's
      // L1_INFO_TREE_INDEX_LEGACY_BARE_NOT_FOUND), so it must NOT produce a
      // failedNetworks entry — otherwise every in-flight pre-settlement deposit
      // floods it on every poll. Do not delete this assertion.
      expect(page.failedNetworks).toEqual([]);
    });

    it('READY_TO_CLAIM: not claimed AND probe succeeds (post-settlement — code-verified against bridge.go, not fixture-captured: all enclave L2->L1 deposits were pre-settlement)', async () => {
      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: loadFixture('bridges_network1.json') },
          d: { status: 200, body: loadFixture('claims_network0.json') },
        }),
        rule(BASE_1, ['/l1-info-tree-index'], 200, '2'),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('READY_TO_CLAIM');
      expect(row?.leafIndexForProof).toBe(2);
    });

    it('CLAIMED: global_index present in the L1 claims set (synthetic — real claims_network0.json has no L2->L1 autoclaim yet)', async () => {
      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: loadFixture('bridges_network1.json') },
          d: {
            status: 200,
            body: claimsBody(
              [
                {
                  global_index: '0',
                  tx_hash: '0xclaimtx',
                  block_timestamp: 999,
                  block_num: 42,
                },
              ],
              1
            ),
          },
        }),
        // The other 2 rows (global_index "1", "2") are NOT in the synthetic
        // claims set above and fall through to a Tier-2 probe; not the row
        // under test here, but still needs a rule.
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_network1_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('CLAIMED');
      expect(row?.claimTransactionHash).toBe('0xclaimtx');
      expect(row?.claimBlockNumber).toBe(42);
    });
  });

  describe('getActivity — status derivation: L2 -> L1 native-gas-token withdrawal (regression)', () => {
    // Regression: a
    // withdrawal of the L2's native gas token (mirrors L1 ETH) always has
    // `origin_network: 0`, but is recorded on the L2's OWN local exit tree
    // (this row is fetched via call A, `network_id=1`) — NOT network 0's
    // tree. The probe must therefore be keyed by the RECORDING network (1),
    // not `bridge.origin_network` (0). We install a deliberately-diverging
    // pair of `/l1-info-tree-index` rules — network_id=1 (correct) 500s
    // "not found", network_id=0 (the old buggy probe target) 200s — so this
    // test fails loudly if the probe regresses to using `origin_network`.
    it('probes by recording network (1), not origin_network (0): derives BRIDGED, not READY_TO_CLAIM', async () => {
      const withdrawalRow = makeBridge({
        bridge_hash: '0xnativewithdrawal',
        origin_network: 0,
        origin_address: '0x0000000000000000000000000000000000000000',
        destination_network: 0,
        deposit_count: 184,
        global_index: 184,
        block_timestamp: 400,
      });

      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: bridgesBody([withdrawalRow], 1) },
        }),
        // Correct probe target (recordingNetworkId=1): not found -> BRIDGED.
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=184'],
          500,
          errorBody(
            'failed to get l1 info tree index for network id 1 and deposit count 184, error: not found'
          )
        ),
        // Old buggy probe target (bridge.origin_network=0): coincidentally
        // succeeds. If the fix regresses, this rule matches instead and the
        // test below fails (status would read READY_TO_CLAIM).
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=184'],
          200,
          '184'
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.bridgeHash === '0xnativewithdrawal'
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('BRIDGED');
      expect(row?.leafIndexForProof).toBeUndefined();
    });
  });

  describe('getActivity — display mapping: sourceNetwork uses the RECORDING network (regression, bug a)', () => {
    // Regression (bug a, found during manual validation): toTransaction()
    // used to map the displayed
    // `sourceNetwork` from `bridge.origin_network`, which is always 0 for a
    // withdrawal of the L2's native gas token even though the row is
    // recorded on the L2's OWN local exit tree (fetched via call A,
    // `network_id=1`). This is the display counterpart of the S6b
    // status-derivation fix — `sourceNetwork` must reflect
    // `recordingNetworkId` (1), not `bridge.origin_network` (0).
    it('displays the recording network (1) as sourceNetwork, not bridge.origin_network (0)', async () => {
      const withdrawalRow = makeBridge({
        bridge_hash: '0xnativewithdrawaldisplay',
        origin_network: 0,
        origin_address: '0x0000000000000000000000000000000000000000',
        destination_network: 0,
        deposit_count: 777,
        global_index: 777,
        block_timestamp: 700,
      });

      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: bridgesBody([withdrawalRow], 1) },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=777'],
          500,
          errorBody(
            'failed to get l1 info tree index for network id 1 and deposit count 777, error: not found'
          )
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.bridgeHash === '0xnativewithdrawaldisplay'
      );
      expect(row).toBeDefined();
      // bridge.origin_network is 0 (asset origin, L1 ETH); the recording
      // network — and therefore the displayed sourceNetwork — is 1.
      expect(row?.sourceNetwork).toBe(1);
      expect(row?.destinationNetwork).toBe(0);
    });
  });

  describe('getActivity — status derivation: L2 -> L2 (cross-instance join)', () => {
    it('CLAIMED via cross-instance join: destination network Y (6) claims-set contains the origin (5) bridge global_index', async () => {
      const row = makeBridge({
        bridge_hash: '0xl2l2claimed',
        origin_network: 5,
        destination_network: 6,
        deposit_count: 10,
        global_index: 10,
        block_timestamp: 300,
      });

      installRouter([
        ...networkRules(BASE_1, 5, {
          a: { status: 200, body: bridgesBody([row], 1) },
        }),
        ...networkRules(BASE_2, 6, {
          c: { status: 200, body: claimsBody([{ global_index: '10' }], 1) },
        }),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 5: BASE_1, 6: BASE_2 },
      });

      const page = await aggregator.getActivity({ fromAddress: ADDRESS });
      const tx = page.data.find((t) => t.bridgeHash === '0xl2l2claimed');

      expect(tx).toBeDefined();
      expect(tx?.status).toBe('CLAIMED');
      expect(tx?.sourceNetwork).toBe(5);
      expect(tx?.destinationNetwork).toBe(6);
    });

    it('READY_TO_CLAIM via origin-instance probe when destination network Y (6) has no matching claim', async () => {
      const row = makeBridge({
        bridge_hash: '0xl2l2ready',
        origin_network: 5,
        destination_network: 6,
        deposit_count: 11,
        global_index: 11,
        block_timestamp: 301,
      });

      installRouter([
        ...networkRules(BASE_1, 5, {
          a: { status: 200, body: bridgesBody([row], 1) },
        }),
        ...networkRules(BASE_2, 6, {}),
        rule(BASE_1, ['/l1-info-tree-index'], 200, '1'),
        // destination_network=6 (L2) -> Tier-2b gate queries network 6's own
        // instance (BASE_2). Injected exactly at the source index.
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=6', 'leaf_index=1'],
          200,
          injectedLeafBody(1)
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 5: BASE_1, 6: BASE_2 },
      });

      const page = await aggregator.getActivity({ fromAddress: ADDRESS });
      const tx = page.data.find((t) => t.bridgeHash === '0xl2l2ready');

      expect(tx).toBeDefined();
      expect(tx?.status).toBe('READY_TO_CLAIM');
      expect(tx?.leafIndexForProof).toBe(1);
    });
  });

  describe('getActivity — L2 -> L2 injected-leaf gate (live-captured l2l2_* lifecycle fixtures)', () => {
    // Origin tx 0xac862504..., L2-1 deposit_count=2, global_index=2,
    // destination_network=2. l2l2_lifecycle_origin_bridges_row.json's Tier-2a
    // probe (l1-info-tree-index) is 200 with body 7 in both snapshots below;
    // only the destination's injected-leaf response differs (the premature
    // 404 vs. the post-injection 200): the premature window must derive
    // LEAF_INCLUDED, never an actionable READY_TO_CLAIM.
    const TARGET_GLOBAL_INDEX = '2';

    it('LEAF_INCLUDED (not READY_TO_CLAIM) during the premature window: source settled (N=7) but destination GER not yet injected (16:53:38.016Z snapshot)', async () => {
      installRouter([
        // confirmClaimed's targeted global_index query (bug-b backstop) MUST
        // be distinguished from the generic dest_claims rule below (which
        // carries an unrelated global_index="0" claim) — otherwise the
        // targeted query would wrongly "confirm" this row as claimed.
        rule(
          BASE_2,
          ['/claims', 'network_id=2', 'global_index=2'],
          200,
          claimsBody([], 0)
        ),
        ...networkRules(BASE_1, 1, {
          a: {
            status: 200,
            body: loadFixture('l2l2_lifecycle_origin_bridges_row.json'),
          },
        }),
        ...networkRules(BASE_2, 2, {
          c: {
            status: 200,
            body: loadFixture('l2l2_165338016Z_dest_claims.json'),
          },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        // Other rows in the same fixture (deposit_count 0/1) aren't the
        // target of this test but still need a rule or the router throws.
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_notfound_error.json')
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
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('LEAF_INCLUDED');
      expect(row?.leafIndexForProof).toBeUndefined();
      expect(page.failedNetworks).toEqual([]);
    });

    // C2 end-to-end through getActivity: before this, the two rc6 404s and the
    // 503 on /injected-l1-info-leaf all threw, so the row degraded to
    // LEAF_INCLUDED *plus* a failedNetworks entry naming the destination network,
    // on every poll for the whole (normal, transient) window. The status is the
    // same either way, so `failedNetworks` is the only thing that distinguishes
    // correct classification from throw-then-degrade.
    it.each([
      [
        'rc6 404 "l1infotreesync has not indexed l1 info tree leaf index N yet (already injected on L2 per l2gersync)"',
        404,
        'injected_l1_info_leaf_rc6_leaf_not_indexed_404.json',
      ],
      [
        'rc6 503 syncer-inconsistent (an ordinary destination-side reorg)',
        503,
        'injected_l1_info_leaf_rc6_syncer_inconsistent_503.json',
      ],
    ])(
      'LEAF_INCLUDED with an EMPTY failedNetworks for the destination-side %s — a transient wait must never be reported as a network failure (audit finding C2)',
      async (_label, status, fixture) => {
        installRouter([
          rule(
            BASE_2,
            ['/claims', 'network_id=2', 'global_index=2'],
            200,
            claimsBody([], 0)
          ),
          ...networkRules(BASE_1, 1, {
            a: {
              status: 200,
              body: loadFixture('l2l2_lifecycle_origin_bridges_row.json'),
            },
          }),
          ...networkRules(BASE_2, 2, {
            c: {
              status: 200,
              body: loadFixture('l2l2_165338016Z_dest_claims.json'),
            },
          }),
          rule(
            BASE_1,
            ['/l1-info-tree-index', 'deposit_count=2'],
            200,
            loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
          ),
          rule(
            BASE_1,
            ['/l1-info-tree-index'],
            500,
            loadFixture('l1_info_tree_index_notfound_error.json')
          ),
          rule(
            BASE_2,
            ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
            status,
            loadFixture(fixture)
          ),
        ]);

        const aggregator = new AggkitBridgeAggregator({
          networks: { 1: BASE_1, 2: BASE_2 },
        });
        const page = await aggregator.getActivity({ fromAddress: ADDRESS });

        const row = page.data.find(
          (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
        );
        expect(row).toBeDefined();
        expect(row?.status).toBe('LEAF_INCLUDED');
        expect(row?.leafIndexForProof).toBeUndefined();
        expect(page.failedNetworks).toEqual([]);
      }
    );

    it('READY_TO_CLAIM with leafIndexForProof = 7 once the destination GER is injected (16:53:46.035Z snapshot, counterfactual pre-autoclaim)', async () => {
      installRouter([
        rule(
          BASE_2,
          ['/claims', 'network_id=2', 'global_index=2'],
          200,
          claimsBody([], 0)
        ),
        ...networkRules(BASE_1, 1, {
          a: {
            status: 200,
            body: loadFixture('l2l2_lifecycle_origin_bridges_row.json'),
          },
        }),
        ...networkRules(BASE_2, 2, {
          // Still not-yet-claimed (count=1) — isolates the injected-leaf
          // transition from the autoclaim that landed moments later live.
          c: {
            status: 200,
            body: loadFixture('l2l2_165338016Z_dest_claims.json'),
          },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_notfound_error.json')
        ),
        rule(
          BASE_2,
          ['/injected-l1-info-leaf', 'network_id=2', 'leaf_index=7'],
          200,
          loadFixture('l2l2_165346035Z_injected_l1_info_leaf_7.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find(
        (tx) => tx.globalIndex === TARGET_GLOBAL_INDEX
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe('READY_TO_CLAIM');
      expect(row?.leafIndexForProof).toBe(7);
    });
  });

  describe('getActivity — L2 -> L1 (destination 0) skips Tier-2b entirely (live-captured l2l1_* lifecycle fixtures)', () => {
    it('derives READY_TO_CLAIM with no /injected-l1-info-leaf request', async () => {
      installRouter([
        // confirmClaimed's targeted global_index=3 query MUST be
        // distinguished from the generic claims_network0 rule below (which
        // carries an unrelated already-claimed global_index="1" row).
        rule(
          BASE_1,
          ['/claims', 'network_id=0', 'global_index=3'],
          200,
          claimsBody([], 0)
        ),
        ...networkRules(BASE_1, 1, {
          a: {
            status: 200,
            body: loadFixture('l2l1_lifecycle_origin_bridges_row.json'),
          },
          d: {
            status: 200,
            body: loadFixture('l2l1_lifecycle_claims_network0_unclaimed.json'),
          },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'deposit_count=3'],
          200,
          loadFixture('l2l1_lifecycle_l1_info_tree_index_ready.json')
        ),
        // Other rows in the fixture (deposit_count 0/1/2) aren't the target
        // of this test but still need a rule or the router throws.
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_notfound_error.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find((tx) => tx.globalIndex === '3');
      expect(row).toBeDefined();
      expect(row?.status).toBe('READY_TO_CLAIM');
      expect(row?.leafIndexForProof).toBe(7);

      const calls = (global.fetch as Mock).mock.calls as [string][];
      const injectedLeafCalls = calls.filter(([url]) =>
        url.includes('/injected-l1-info-leaf')
      );
      expect(injectedLeafCalls).toHaveLength(0);
    });
  });

  describe('getActivity — proxy 502 on a per-row destination probe', () => {
    it('resolves (does not reject) the whole getActivity call; the row degrades to LEAF_INCLUDED and failedNetworks names only the failing destination network', async () => {
      installRouter([
        rule(
          BASE_2,
          ['/claims', 'network_id=2', 'global_index=2'],
          200,
          claimsBody([], 0)
        ),
        ...networkRules(BASE_1, 1, {
          a: {
            status: 200,
            body: loadFixture('l2l2_lifecycle_origin_bridges_row.json'),
          },
        }),
        ...networkRules(BASE_2, 2, {
          c: {
            status: 200,
            body: loadFixture('l2l2_165338016Z_dest_claims.json'),
          },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'deposit_count=2'],
          200,
          loadFixture('l2l2_165338016Z_l1_info_tree_index.json')
        ),
        rule(
          BASE_1,
          ['/l1-info-tree-index'],
          500,
          loadFixture('l1_info_tree_index_notfound_error.json')
        ),
        // Network 2's backend is "stopped" — the destination-injected-leaf
        // probe 502s (__fixtures__/error_502_stopped_backend.json).
        rule(
          BASE_2,
          ['/injected-l1-info-leaf'],
          502,
          loadFixture('error_502_stopped_backend.json')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1, 2: BASE_2 },
      });

      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const row = page.data.find((tx) => tx.globalIndex === '2');
      expect(row).toBeDefined();
      expect(row?.status).toBe('LEAF_INCLUDED');

      expect(page.failedNetworks).toHaveLength(1);
      expect(page.failedNetworks[0]?.networkId).toBe(2);
      expect(page.failedNetworks[0]?.httpStatus).toBe(502);
    });
  });

  describe('getReadyToClaimCount', () => {
    it('counts only the unclaimed rows whose l1-info-tree-index probe succeeds, bounded to the unclaimed set', async () => {
      const readyRow = makeBridge({
        bridge_hash: '0xready',
        deposit_count: 1,
        global_index: 1,
        origin_network: 1,
      });
      const bridgedRow = makeBridge({
        bridge_hash: '0xbridged',
        deposit_count: 2,
        global_index: 2,
        origin_network: 1,
      });
      const claimedRow = makeBridge({
        bridge_hash: '0xclaimed',
        deposit_count: 3,
        global_index: 3,
        origin_network: 1,
        // Matched against network 1's OWN claims set ("claimsHere", the `c`
        // call below), so its destination must be network 1.
        destination_network: 1,
      });

      installRouter([
        ...networkRules(BASE_1, 1, {
          a: {
            status: 200,
            body: bridgesBody([readyRow, bridgedRow, claimedRow], 3),
          },
          c: { status: 200, body: claimsBody([{ global_index: '3' }], 1) },
        }),
        rule(BASE_1, ['/l1-info-tree-index', 'deposit_count=1'], 200, '1'),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'deposit_count=2'],
          500,
          errorBody('this bridge has not been included on the L1 Info Tree yet')
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const count = await aggregator.getReadyToClaimCount({
        fromAddress: ADDRESS,
      });

      // Only 0xready resolves READY_TO_CLAIM; 0xbridged probes not-ready;
      // 0xclaimed is excluded from the unclaimed set entirely (never probed).
      expect(count).toBe(1);
    });

    it('regression: native-gas-token withdrawal (origin_network=0, recorded on network 1) is NOT counted ready when only the origin_network=0 probe would coincidentally succeed', async () => {
      const withdrawalRow = makeBridge({
        bridge_hash: '0xnativewithdrawalcount',
        origin_network: 0,
        origin_address: '0x0000000000000000000000000000000000000000',
        destination_network: 0,
        deposit_count: 184,
        global_index: 184,
      });

      installRouter([
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: bridgesBody([withdrawalRow], 1) },
        }),
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=1', 'deposit_count=184'],
          500,
          errorBody(
            'failed to get l1 info tree index for network id 1 and deposit count 184, error: not found'
          )
        ),
        // Coincidental collision if the probe wrongly used origin_network=0.
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=184'],
          200,
          '184'
        ),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const count = await aggregator.getReadyToClaimCount({
        fromAddress: ADDRESS,
      });

      expect(count).toBe(0);
    });
  });

  describe('claims-pagination correctness (regression, bug b)', () => {
    // Regression (bug b, found during manual validation):
    // fetchNetworkFanout()'s /claims call only ever
    // reads page 1 (page_size 200), with no address filter. Once a
    // network's total claim count exceeds one page, an already-claimed
    // deposit whose claim landed beyond page 1 is invisible to the Tier-1
    // claims-set join and gets mis-derived as READY_TO_CLAIM. The fix adds a
    // targeted `/claims?global_index=<gi>` confirmation for candidates that
    // pass the Tier-2 leaf-included probe (i.e. that would otherwise become
    // READY_TO_CLAIM), bounded to that small per-page candidate set.
    //
    // Here, page 1 of /claims?network_id=1 comes back EMPTY with a large
    // `count` (348) — simulating the real deposit's claim sitting on some
    // later page — while the targeted global_index query for this exact
    // deposit DOES find it. Both getActivity (status derivation) and
    // getReadyToClaimCount (badge count) must apply the same confirmation.
    it('a deposit whose claim is not on page 1 of /claims is derived CLAIMED (not READY_TO_CLAIM) and is NOT counted by getReadyToClaimCount', async () => {
      const paginatedClaimRow = makeBridge({
        bridge_hash: '0xpaginatedclaim',
        origin_network: 0,
        origin_address: '0x0000000000000000000000000000000000000000',
        destination_network: 1,
        deposit_count: 500,
        global_index: 500,
        block_timestamp: 500,
      });

      const routerRules = [
        // Targeted per-candidate confirmation (must be listed before the
        // generic page-1 /claims rule below so it's matched first — it
        // additionally requires `global_index=500` in the URL).
        rule(
          BASE_1,
          ['/claims', 'network_id=1', 'global_index=500'],
          200,
          claimsBody(
            [
              {
                tx_hash: '0xconfirmedclaimtxhash',
                global_index: '500',
                block_timestamp: 999,
                block_num: 42,
              },
            ],
            1
          )
        ),
        ...networkRules(BASE_1, 1, {
          b: { status: 200, body: bridgesBody([paginatedClaimRow], 1) },
          // Page 1 of /claims?network_id=1 does NOT include this deposit's
          // claim, but `count` (348) indicates more pages exist — exactly
          // the shape that caused the original false READY_TO_CLAIM.
          c: { status: 200, body: claimsBody([], 348) },
        }),
        // Leaf-included probe succeeds (recordingNetworkId=0, an L1-origin
        // deposit fetched via call B) — this is what makes the row a
        // READY_TO_CLAIM *candidate*, triggering the targeted confirmation.
        rule(
          BASE_1,
          ['/l1-info-tree-index', 'network_id=0', 'deposit_count=500'],
          200,
          '500'
        ),
      ];

      installRouter(routerRules);
      const activityAggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await activityAggregator.getActivity({
        fromAddress: ADDRESS,
      });
      const row = page.data.find((tx) => tx.bridgeHash === '0xpaginatedclaim');
      expect(row).toBeDefined();
      expect(row?.status).toBe('CLAIMED');
      expect(row?.claimTransactionHash).toBe('0xconfirmedclaimtxhash');

      // getReadyToClaimCount must apply the same confirmation, over a fresh
      // router install (getReadyToClaimCount re-fetches independently).
      installRouter(routerRules);
      const countAggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const count = await countAggregator.getReadyToClaimCount({
        fromAddress: ADDRESS,
      });
      expect(count).toBe(0);
    });
  });

  describe('confirmClaimed — global_index mismatch guard (comment 3847451952)', () => {
    it('does not treat a claim with a DIFFERENT global_index as a match: derives READY_TO_CLAIM, not CLAIMED', async () => {
      // Simulates a proxy that drops the `global_index` filter param: the
      // targeted confirmClaimed query for global_index=42 comes back with
      // an unrelated claim (global_index "999") instead of an empty or
      // matching result.
      const mismatchedRow = makeBridge({
        bridge_hash: '0xmismatchedclaim',
        origin_network: 1,
        destination_network: 0,
        deposit_count: 42,
        global_index: 42,
        block_timestamp: 900,
      });

      installRouter([
        // Must be matched before the generic `d` rule below (network_id=0
        // claims, no global_index requirement), which would otherwise
        // return the default empty response instead of this deliberately
        // mismatched claim.
        rule(
          BASE_1,
          ['/claims', 'network_id=0', 'global_index=42'],
          200,
          claimsBody(
            [
              {
                global_index: '999',
                tx_hash: '0xstrangertx',
                block_timestamp: 111,
                block_num: 1,
              },
            ],
            1
          )
        ),
        ...networkRules(BASE_1, 1, {
          a: { status: 200, body: bridgesBody([mismatchedRow], 1) },
        }),
        rule(BASE_1, ['/l1-info-tree-index', 'deposit_count=42'], 200, '42'),
      ]);

      const aggregator = new AggkitBridgeAggregator({
        networks: { 1: BASE_1 },
      });
      const page = await aggregator.getActivity({ fromAddress: ADDRESS });

      const tx = page.data.find((t) => t.bridgeHash === '0xmismatchedclaim');
      expect(tx).toBeDefined();
      expect(tx?.status).toBe('READY_TO_CLAIM');
      expect(tx?.leafIndexForProof).toBe(42);
      expect(tx?.claimTransactionHash).toBeUndefined();
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
          500,
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

    it("L2 -> L1: rc4/rc5's bare \"not found\" 500 carrier returns { claimable: false, reason: 'SOURCE_NOT_ON_L1_INFO_TREE' } — NOT a throw — end-to-end (l1_info_tree_index_network1_error.json, live-captured; audit finding C1)", async () => {
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

      const result = await aggregator.getClaimInputs({
        recordingNetworkId: 1,
        destinationNetworkId: 0,
        depositCount: 0,
      });

      expect(result).toEqual({
        claimable: false,
        reason: 'SOURCE_NOT_ON_L1_INFO_TREE',
        detail: expect.stringContaining('error: not found'),
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
