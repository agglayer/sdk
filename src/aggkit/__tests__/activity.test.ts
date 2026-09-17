import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AggkitBridgeClient } from '../client';
import { AggkitBridgeAggregator } from '../aggregator';
import { AggkitApiError } from '../errors';
import { quoteGlobalIndex } from '../parsing';
import type { AggkitActivityItem } from '../types';

// ---------------------------------------------------------------------------
// Cross-network activity (`tracker/v1/activity`) unit tests. This endpoint
// REPLACED the client-side `/bridge/v1` fan-out `AggkitBridgeAggregator
// .getActivity` used before (and the now-removed `getReadyToClaimCount`) —
// see `AggkitActivityResult`'s module doc in `types.ts` for the full
// rationale.
//
// Two kinds of response body are used below:
//
//  - `makeActivityItem` builds a synthetic row from aggkit's
//    `docs/bridgetracker/API.md` `ActivityResponse` schema, matching
//    agglayer-dev-ui's own already-reviewed `app/services/activity.ts` port
//    (S-review 2026-08-28). Used for shape/branch coverage where no live
//    capture is needed.
//  - `activity_rc9_live_prefix.json` / `activity_rc9_live_postfix.json` are
//    VERBATIM live captures of this endpoint from a 2-L2 anvil devnet on
//    2026-09-08 — the pre-fix one from aggkit v0.11.0-rc9, the post-fix one
//    from a build of the `BridgeResponse.GlobalIndex -> BigIntString` fix
//    that lands as agglayer/aggkit#1835. They are the ground truth for the
//    `global_index` precision workaround in `parsing.ts`; see
//    `src/aggkit/__fixtures__/README.md` for their full provenance.
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  return readFileSync(
    new URL(`../__fixtures__/${name}`, import.meta.url),
    'utf-8'
  );
}

function mockResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function mockFetchOnce(text: string, status: number): void {
  (global.fetch as Mock).mockResolvedValueOnce(mockResponse(text, status));
}

/**
 * Mocks EVERY fetch with the same response, not just the next one. Used where
 * the assertion is about how many requests were made: with
 * `mockResolvedValueOnce`, a second request falls off the end of the mock and
 * fails with an unrelated transport error, so the request-count assertion
 * never gets to be the thing that catches the regression.
 */
function mockFetchAlways(text: string, status: number): void {
  (global.fetch as Mock).mockImplementation(() =>
    Promise.resolve(mockResponse(text, status))
  );
}

function fetchCallCount(): number {
  return (global.fetch as Mock).mock.calls.length;
}

function lastFetchUrl(): string {
  const mock = global.fetch as Mock;
  const call = mock.mock.calls[mock.mock.calls.length - 1] as [string, unknown];
  return call[0];
}

/** Minimal-but-complete synthetic activity item, matching aggkit's ActivityResponse schema. */
function makeActivityItem(
  overrides: Partial<AggkitActivityItem> = {}
): AggkitActivityItem {
  return {
    bridge: {
      block_num: 1,
      block_pos: 0,
      block_timestamp: 1000,
      bridge_hash: '0xbridgehash',
      tx_hash: '0xtxhash',
      deposit_count: 1,
      destination_address: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
      destination_network: 2,
      from_address: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
      global_index: '1',
      leaf_type: 0,
      metadata: '0x',
      origin_address: '0x0000000000000000000000000000000000000000',
      origin_network: 1,
      to_address: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
      txn_sender: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
      amount: '1000000000000000000',
    },
    bridge_network_id: 1,
    claim_status: 'pending',
    creation_timestamp: 1000,
    last_updated_timestamp: 1000,
    ...overrides,
  };
}

function activityBody(
  bridges: AggkitActivityItem[],
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    bridges,
    // Hex string on the wire (`common.Address.MarshalText`), lowercased —
    // not a byte array. See the comment in `AggkitBridgeClient.getActivity`.
    from_address: ADDRESS.toLowerCase(),
    ...extra,
  });
}

const BASE_URL = 'http://127.0.0.1:33460';
const ADDRESS = '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE';

// ---------------------------------------------------------------------------
// Live-capture constants. The address, and the deposit's identity, are the
// ones actually present in the two fixtures — asserting on literals here (and
// not on values re-read out of the fixture) is the point: if the wire format
// or the capture ever changes, these must fail rather than silently follow.
// ---------------------------------------------------------------------------

/** The `from_address` the two live captures were fetched for, original casing. */
const LIVE_ADDRESS = '0x8943545177806ED17B9F23F0a21ee5948eCaa776';

/**
 * The live deposit's `global_index`, exactly as it must reach the caller: a
 * `string`, all 20 digits intact. `2^64 + 2` — an L1-origin deposit's global
 * index sets bit 64, so every L1-origin row is above
 * `Number.MAX_SAFE_INTEGER` and cannot survive a plain `JSON.parse`.
 */
const LIVE_GLOBAL_INDEX = '18446744073709551618';

/**
 * What a plain `JSON.parse` of the pre-fix capture yields for the same field:
 * the nearest IEEE-754 double, silently 1618 -> 2000 in the last four digits.
 * This is the corruption `quoteGlobalIndex` exists to prevent.
 */
const CORRUPTED_GLOBAL_INDEX = 18446744073709552000;

const LIVE_PREFIX_FIXTURE = 'activity_rc9_live_prefix.json';
const LIVE_POSTFIX_FIXTURE = 'activity_rc9_live_postfix.json';

describe('AggkitBridgeClient.getActivity', () => {
  let client: AggkitBridgeClient;

  beforeEach(() => {
    global.fetch = vi.fn();
    client = new AggkitBridgeClient({ baseUrl: BASE_URL, networkId: 1 });
  });

  describe('URL construction', () => {
    it("builds /tracker/v1/activity/from/{address}?includeTracking=false by default — the tracker's own default, and not a server-side write", async () => {
      mockFetchOnce(activityBody([]), 200);
      await client.getActivity({ fromAddress: ADDRESS });
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
      );
    });

    it('honors an explicit includeTracking: true', async () => {
      mockFetchOnce(activityBody([]), 200);
      await client.getActivity({
        fromAddress: ADDRESS,
        includeTracking: true,
      });
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=true`
      );
    });

    it('honors an explicit includeTracking: false', async () => {
      mockFetchOnce(activityBody([]), 200);
      await client.getActivity({
        fromAddress: ADDRESS,
        includeTracking: false,
      });
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
      );
    });

    it('builds the activity URL from trackerBaseUrl when given, leaving baseUrl for /bridge/v1 only', async () => {
      const trackerUrl = 'http://127.0.0.1:33470';
      const split = new AggkitBridgeClient({
        baseUrl: BASE_URL,
        trackerBaseUrl: trackerUrl,
        networkId: 1,
      });
      mockFetchOnce(activityBody([]), 200);

      await split.getActivity({ fromAddress: ADDRESS });

      // The bridge tracker is its own aggkit service; pointed at a bridge
      // service, every `/tracker/v1` route 404s.
      expect(lastFetchUrl()).toBe(
        `${trackerUrl}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
      );
      expect(lastFetchUrl()).not.toContain(BASE_URL);
    });

    it('falls back to baseUrl for the activity URL when trackerBaseUrl is omitted', async () => {
      mockFetchOnce(activityBody([]), 200);
      await client.getActivity({ fromAddress: ADDRESS });
      // Preserves the single-URL behaviour this client shipped with — correct
      // when an aggkit-proxy fronts both services.
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
      );
    });

    it('URL-encodes fromAddress instead of interpolating it raw into the path (PR #33 review)', async () => {
      mockFetchOnce(activityBody([]), 200);
      const unexpected = '../etc/passwd?x=1&y=2';
      await client.getActivity({ fromAddress: unexpected });
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/activity/from/${encodeURIComponent(unexpected)}?includeTracking=false`
      );
    });
  });

  describe('response parsing', () => {
    it('returns bridges + warnings, and drops the useless from_address byte-array echo', async () => {
      const item = makeActivityItem({ claim_status: 'claimed' });
      mockFetchOnce(
        activityBody([item], {
          warnings: [{ network_id: 2, message: 'bridge service unreachable' }],
        }),
        200
      );

      const result = await client.getActivity({ fromAddress: ADDRESS });

      expect(result.bridges).toEqual([item]);
      expect(result.warnings).toEqual([
        { network_id: 2, message: 'bridge service unreachable' },
      ]);
      expect(result).not.toHaveProperty('from_address');
    });

    it('defaults warnings to [] when the response omits the key entirely', async () => {
      mockFetchOnce(activityBody([makeActivityItem()]), 200);
      const result = await client.getActivity({ fromAddress: ADDRESS });
      expect(result.warnings).toEqual([]);
    });

    it('preserves claim_status and an optional joined claim/tracking', async () => {
      const claimedItem = makeActivityItem({
        claim_status: 'claimed',
        claim: {
          tx_hash: '0xclaimtx',
          amount: '1000000000000000000',
          block_num: 5,
          block_timestamp: 2000,
          destination_address: ADDRESS,
          destination_network: 2,
          from_address: '',
          global_exit_root: '0xger',
          global_index: '1',
          is_message: false,
          mainnet_exit_root: '0xmer',
          metadata: '0x',
          origin_address: '0x0000000000000000000000000000000000000000',
          origin_network: 1,
          proof_local_exit_root: [],
          proof_rollup_exit_root: [],
          rollup_exit_root: '0xrer',
        },
      });
      mockFetchOnce(activityBody([claimedItem]), 200);

      const result = await client.getActivity({ fromAddress: ADDRESS });

      expect(result.bridges[0]?.claim_status).toBe('claimed');
      expect(result.bridges[0]?.claim?.tx_hash).toBe('0xclaimtx');
    });

    it('surfaces claim_status: "error" with a per-kind errors map, never coerced to "pending"', async () => {
      const erroredItem = makeActivityItem({
        claim_status: 'error',
        errors: { claim: 'isClaimed() call reverted' },
      });
      mockFetchOnce(activityBody([erroredItem]), 200);

      const result = await client.getActivity({ fromAddress: ADDRESS });

      expect(result.bridges[0]?.claim_status).toBe('error');
      expect(result.bridges[0]?.errors).toEqual({
        claim: 'isClaimed() call reverted',
      });
    });

    it('surfaces claim_status: "readyToClaim", resolved without a tracking snapshot on the item (agglayer/aggkit#1830, PR #1831)', async () => {
      const readyItem = makeActivityItem({ claim_status: 'readyToClaim' });
      mockFetchOnce(activityBody([readyItem]), 200);

      const result = await client.getActivity({
        fromAddress: ADDRESS,
        includeTracking: false,
      });

      expect(result.bridges[0]?.claim_status).toBe('readyToClaim');
      expect(result.bridges[0]?.tracking).toBeUndefined();
    });

    it('reports a failed readiness probe under errors.readiness while staying claim_status: "pending"', async () => {
      const item = makeActivityItem({
        claim_status: 'pending',
        errors: {
          readiness: 'fetching l1 info tree index: context deadline exceeded',
        },
      });
      mockFetchOnce(activityBody([item]), 200);

      const result = await client.getActivity({ fromAddress: ADDRESS });

      expect(result.bridges[0]?.claim_status).toBe('pending');
      expect(result.bridges[0]?.errors).toEqual({
        readiness: 'fetching l1 info tree index: context deadline exceeded',
      });
    });
  });

  describe('error handling', () => {
    it('throws AggkitApiError using the TRACKER error shape ({code, message}), not the bridge-service {error} shape', async () => {
      mockFetchOnce(
        JSON.stringify({ code: 400, message: 'invalid address' }),
        400
      );

      try {
        await client.getActivity({ fromAddress: 'not-an-address' });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AggkitApiError);
        expect((error as AggkitApiError).httpStatus).toBe(400);
        expect((error as AggkitApiError).message).toContain('invalid address');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Live rc9 capture: the `global_index` precision defect, end to end.
//
// The reviewer's ask was for a live capture rather than a hand-built body, so
// these run the fixtures' exact bytes through the real `getActivity` parse
// path. See `src/aggkit/__fixtures__/README.md` for provenance.
// ---------------------------------------------------------------------------
describe('AggkitBridgeClient.getActivity over the live aggkit v0.11.0-rc9 capture', () => {
  let client: AggkitBridgeClient;

  beforeEach(() => {
    global.fetch = vi.fn();
    client = new AggkitBridgeClient({ baseUrl: BASE_URL, networkId: 1 });
  });

  it('returns the L1-origin bridge global_index as the exact 20-digit string, losing no precision on the pre-fix wire format', async () => {
    mockFetchOnce(loadFixture(LIVE_PREFIX_FIXTURE), 200);

    const result = await client.getActivity({ fromAddress: LIVE_ADDRESS });

    // Value first, deliberately: a regression that reintroduces
    // `JSON.parse(text)` then fails with the corrupted double printed
    // side-by-side with the true value, which is the whole diagnostic.
    const globalIndex = result.bridges[0]?.bridge.global_index;
    expect(globalIndex).toBe(LIVE_GLOBAL_INDEX);
    expect(typeof globalIndex).toBe('string');
    expect(globalIndex).not.toBe(String(CORRUPTED_GLOBAL_INDEX));
  });

  it('would corrupt that same global_index to an imprecise double under a plain JSON.parse — the defect quoteGlobalIndex exists for', () => {
    const raw = loadFixture(LIVE_PREFIX_FIXTURE);

    // Exactly what `getActivity` did before the fix, and what any consumer
    // doing its own `JSON.parse` on this endpoint still gets.
    const naive = JSON.parse(raw) as {
      bridges: Array<{
        bridge: { global_index: number };
        claim?: { global_index: string };
      }>;
    };
    const naiveBridgeIndex = naive.bridges[0]?.bridge.global_index;

    expect(typeof naiveBridgeIndex).toBe('number');
    expect(naiveBridgeIndex).toBe(CORRUPTED_GLOBAL_INDEX);
    expect(String(naiveBridgeIndex)).not.toBe(LIVE_GLOBAL_INDEX);

    // The claim-level field is the same logical value but was already a
    // quoted string on the wire (`ClaimResponse` uses `BigIntString`), so it
    // survives the naive parse untouched. That asymmetry inside ONE response
    // is what pins the defect to `BridgeResponse`, not to the endpoint.
    expect(naive.bridges[0]?.claim?.global_index).toBe(LIVE_GLOBAL_INDEX);
  });

  it('returns the identical global_index string from the post-fix capture, so the pre-quoting is idempotent once agglayer/aggkit#1835 ships', async () => {
    mockFetchOnce(loadFixture(LIVE_POSTFIX_FIXTURE), 200);

    const result = await client.getActivity({ fromAddress: LIVE_ADDRESS });

    const globalIndex = result.bridges[0]?.bridge.global_index;
    expect(typeof globalIndex).toBe('string');
    expect(globalIndex).toBe(LIVE_GLOBAL_INDEX);
  });

  it('quotes only the bare-number occurrence in the pre-fix capture and leaves the already-quoted post-fix capture byte-identical', () => {
    const prefix = loadFixture(LIVE_PREFIX_FIXTURE);
    const postfix = loadFixture(LIVE_POSTFIX_FIXTURE);

    // The pre-fix body genuinely carries both encodings of the same value.
    expect(prefix).toContain(`"global_index":${LIVE_GLOBAL_INDEX}`);
    expect(prefix).toContain(`"global_index":"${LIVE_GLOBAL_INDEX}"`);

    const quoted = quoteGlobalIndex(prefix);
    expect(quoted).not.toContain(`"global_index":${LIVE_GLOBAL_INDEX}`);
    expect(
      quoted.split(`"global_index":"${LIVE_GLOBAL_INDEX}"`).length - 1
    ).toBe(2);
    // Re-applying it is a no-op: the regex only matches an unquoted digit run.
    expect(quoteGlobalIndex(quoted)).toBe(quoted);

    // Post-fix needs no rewriting at all.
    expect(postfix).not.toContain(`"global_index":${LIVE_GLOBAL_INDEX}`);
    expect(quoteGlobalIndex(postfix)).toBe(postfix);
  });

  // Boundary cases the narrow pattern must NOT touch. Each of these would be
  // a corruption if the regex were loosened (e.g. to a bare `global_index`
  // substring match, or to tolerate whitespace around the key), and each
  // leaves the payload valid JSON with the value unchanged.
  it.each([
    ['already-quoted value', '{"global_index":"1"}'],
    ['already-quoted with leading whitespace', '{"global_index":  "1"}'],
    ['null value', '{"global_index": null}'],
    ['key with a prefix', '{"x_global_index": 1}'],
    ['key with a suffix', '{"global_index_x": 1}'],
    [
      'occurrence inside a string literal',
      '{"note":"the \\"global_index\\": 1 is prose"}',
    ],
  ])('leaves %s untouched', (_label, body) => {
    expect(quoteGlobalIndex(body)).toBe(body);
    // Still valid JSON, and re-application is a no-op.
    expect(() => JSON.parse(quoteGlobalIndex(body))).not.toThrow();
  });

  // Values the pattern DOES rewrite, beyond the plain positive integer the
  // live capture exercises. Negative global indices are not currently
  // emitted by aggkit, but `-?` is in the pattern, so pin what it does.
  it.each([
    ['a negative value', '{"global_index": -1}', '{"global_index":"-1"}'],
    [
      'a newline between the colon and the digits',
      '{"global_index":\n  1}',
      '{"global_index":"1"}',
    ],
    ['no whitespace at all', '{"global_index":1}', '{"global_index":"1"}'],
  ])('quotes %s', (_label, body, expected) => {
    const out = quoteGlobalIndex(body);
    expect(out).toBe(expected);
    expect(quoteGlobalIndex(out)).toBe(out);
    expect(JSON.parse(out).global_index).toBe(
      JSON.parse(expected).global_index
    );
  });

  it('handles the capture\'s L1-origin row (bridge_network_id 0) joined with its claim_status "claimed" claim', async () => {
    mockFetchOnce(loadFixture(LIVE_PREFIX_FIXTURE), 200);

    const result = await client.getActivity({ fromAddress: LIVE_ADDRESS });

    expect(result.bridges).toHaveLength(1);
    const row = result.bridges[0];

    // L1-origin: recorded on network 0, destined for L2 network 1. This is
    // the row shape whose `global_index` exceeds 2^64.
    expect(row?.bridge_network_id).toBe(0);
    expect(row?.bridge.origin_network).toBe(0);
    expect(row?.bridge.destination_network).toBe(1);
    expect(row?.bridge.deposit_count).toBe(2);

    // ...and it is claimed, with the claim row joined in, on the destination
    // network rather than the recording one.
    expect(row?.claim_status).toBe('claimed');
    expect(row?.claim_network_id).toBe(1);
    expect(row?.claim).toBeDefined();
    expect(row?.claim?.tx_hash).toBe(
      '0xe1e9cb194eaca6bc34b183f79735b419c4c10d2287162d45c427ef0167cc9670'
    );
    // The claim's own global_index is the same logical value as the bridge's
    // and must read back identically, despite arriving already-quoted.
    expect(row?.claim?.global_index).toBe(LIVE_GLOBAL_INDEX);

    expect(result.warnings).toEqual([]);
  });

  it('parses a live claim whose proof_local_exit_root/proof_rollup_exit_root are absent, without throwing or inventing them', async () => {
    mockFetchOnce(loadFixture(LIVE_PREFIX_FIXTURE), 200);

    const result = await client.getActivity({ fromAddress: LIVE_ADDRESS });
    const claim = result.bridges[0]?.claim;
    expect(claim).toBeDefined();

    // `ClaimResponse` declares both proofs `omitempty`, and this endpoint
    // never populates them — hence `?: string[]` on `AggkitActivityClaim`.
    // The keys are absent, not empty arrays and not null.
    expect(claim && 'proof_local_exit_root' in claim).toBe(false);
    expect(claim && 'proof_rollup_exit_root' in claim).toBe(false);
    expect(claim?.proof_local_exit_root).toBeUndefined();
    expect(claim?.proof_rollup_exit_root).toBeUndefined();

    // NOT the same fields: the two exit ROOTS are present, as single hashes.
    // A test that confused them with the absent `proof_*` arrays would pass
    // for the wrong reason.
    expect(claim?.mainnet_exit_root).toBe(
      '0x47a5c9cfc3ee533777eac790c9ad01594dd15919581a22b78c977a51b596768e'
    );
    expect(claim?.rollup_exit_root).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(claim?.global_exit_root).toBe(
      '0x7f92a1039ba4fb78492f3533ff43c32e76fe4d4f9a0bef3a732f4950f4d3e449'
    );

    // The full set of keys the live claim actually carries — pinned so an
    // added or dropped field on this endpoint has to be looked at.
    expect(Object.keys(claim ?? {}).sort()).toEqual([
      'amount',
      'block_num',
      'block_timestamp',
      'destination_address',
      'destination_network',
      'from_address',
      'global_exit_root',
      'global_index',
      'is_message',
      'mainnet_exit_root',
      'metadata',
      'origin_address',
      'origin_network',
      'rollup_exit_root',
      'tx_hash',
    ]);
  });

  it('carries three different from_address encodings in one response: top-level lowercased (and dropped), bridge mixed-case, claim empty', async () => {
    const raw = loadFixture(LIVE_PREFIX_FIXTURE);
    mockFetchOnce(raw, 200);

    const result = await client.getActivity({ fromAddress: LIVE_ADDRESS });

    // Top level: lowercased by `common.Address.MarshalText`, and therefore
    // useless to the caller, who already knows the casing it asked with — so
    // `getActivity` drops it rather than returning a third spelling.
    expect(raw).toContain(`"from_address":"${LIVE_ADDRESS.toLowerCase()}"`);
    expect(result).not.toHaveProperty('from_address');

    // Nested on the bridge: the ORIGINAL mixed casing survives, because
    // `BridgeResponse.FromAddress` is a plain string, not a `common.Address`.
    expect(result.bridges[0]?.bridge.from_address).toBe(LIVE_ADDRESS);
    expect(result.bridges[0]?.bridge.from_address).not.toBe(
      LIVE_ADDRESS.toLowerCase()
    );

    // Nested on the claim: ALWAYS "" on this endpoint — never usable for
    // identity, which is what `AggkitActivityClaim.from_address`'s doc warns.
    expect(result.bridges[0]?.claim?.from_address).toBe('');
  });
});

describe('AggkitBridgeAggregator.getActivity', () => {
  const L2_1_URL = 'http://127.0.0.1:40001';
  const L2_2_URL = 'http://127.0.0.1:40002';
  /**
   * The bridge TRACKER root. A separate aggkit service from the bridge
   * services in `networks` — deliberately a different host:port here so that
   * a regression routing tracker traffic back through `networks` is visible
   * in the asserted URL rather than accidentally correct.
   */
  const PROXY_URL = 'http://127.0.0.1:40009';

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('sends the request to aggkitProxyUrl, never to a configured networks entry', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL, 2: L2_2_URL },
      aggkitProxyUrl: PROXY_URL,
    });
    const item = makeActivityItem();
    mockFetchOnce(activityBody([item]), 200);

    const result = await aggregator.getActivity({ fromAddress: ADDRESS });

    expect(result.bridges).toEqual([item]);
    expect(lastFetchUrl()).toBe(
      `${PROXY_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
    );
    expect(lastFetchUrl()).not.toContain(L2_1_URL);
    expect(lastFetchUrl()).not.toContain(L2_2_URL);
  });

  it('issues exactly one request no matter how many networks are configured — the tracker fans out server-side', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL, 2: L2_2_URL },
      aggkitProxyUrl: PROXY_URL,
    });
    mockFetchOnce(activityBody([makeActivityItem()]), 200);

    await aggregator.getActivity({ fromAddress: ADDRESS });

    expect(fetchCallCount()).toBe(1);
  });

  it('still routes a bridge-service call through networks, even though the tracker root is set', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL, 2: L2_2_URL },
      aggkitProxyUrl: PROXY_URL,
    });
    mockFetchOnce(loadFixture('bridges_network1.json'), 200);

    await aggregator.clientFor(1).getBridges({ networkId: 1 });

    // `/bridge/v1` traffic must keep going to that network's own bridge
    // service: the per-network clients are handed `trackerBaseUrl` so their
    // `/tracker/v1` routes reach the one tracker, and that must not leak into
    // their bridge-service URL.
    expect(lastFetchUrl()).toBe(`${L2_1_URL}/bridge/v1/bridges?network_id=1`);
    expect(lastFetchUrl()).not.toContain(PROXY_URL);
  });

  it('defaults includeTracking to false', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL },
      aggkitProxyUrl: PROXY_URL,
    });
    mockFetchOnce(activityBody([]), 200);

    await aggregator.getActivity({ fromAddress: ADDRESS });

    expect(lastFetchUrl()).toBe(
      `${PROXY_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
    );
  });

  it('passes includeTracking through unchanged', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL },
      aggkitProxyUrl: PROXY_URL,
    });
    mockFetchOnce(activityBody([]), 200);

    await aggregator.getActivity({
      fromAddress: ADDRESS,
      includeTracking: false,
    });

    expect(lastFetchUrl()).toBe(
      `${PROXY_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
    );

    mockFetchOnce(activityBody([]), 200);
    await aggregator.getActivity({
      fromAddress: ADDRESS,
      includeTracking: true,
    });
    expect(lastFetchUrl()).toBe(
      `${PROXY_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=true`
    );
  });

  it('rejects instead of silently returning an empty result when no aggkitProxyUrl is configured', async () => {
    // `aggkitProxyUrl` is required by `AggkitAggregatorConfig`, so only an
    // un-typechecked JavaScript caller can reach this — hence the cast. The
    // guard must still refuse rather than build `undefined/tracker/v1/...`.
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL },
    } as unknown as ConstructorParameters<typeof AggkitBridgeAggregator>[0]);

    await expect(
      aggregator.getActivity({ fromAddress: ADDRESS })
    ).rejects.toThrow(/no `aggkitProxyUrl` configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects when aggkitProxyUrl is present but blank, rather than requesting a malformed URL', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL },
      aggkitProxyUrl: '   ',
    });

    await expect(
      aggregator.getActivity({ fromAddress: ADDRESS })
    ).rejects.toThrow(/no `aggkitProxyUrl` configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('propagates a genuine tracker failure (AggkitApiError) rather than swallowing it, and does not replay the request', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL, 2: L2_2_URL },
      aggkitProxyUrl: PROXY_URL,
    });
    // Persistent, not `...Once`: a replay must be caught by the request
    // count below, not by the second attempt happening to hit an exhausted
    // mock.
    mockFetchAlways(
      JSON.stringify({ code: 400, message: 'invalid from_address parameter' }),
      400
    );

    let caught: unknown;
    try {
      await aggregator.getActivity({ fromAddress: ADDRESS });
      expect.fail('should have thrown');
    } catch (error) {
      caught = error;
    }

    // A deterministic 400 used to be rewrapped in a plain `Error` carrying an
    // "all configured networks failed" summary, which destroyed both the
    // type and the httpStatus the caller needs to tell "bad request" from
    // "tracker down".
    expect(caught).toBeInstanceOf(AggkitApiError);
    expect((caught as AggkitApiError).httpStatus).toBe(400);
    expect((caught as AggkitApiError).message).toBe(
      'invalid from_address parameter'
    );
    expect((caught as AggkitApiError).endpoint).toBe(
      '/tracker/v1/activity/from/{from_address}'
    );

    // Exactly ONE request: two networks are configured, and the removed
    // failover loop would have replayed the same deterministic 400 against
    // the second one before giving up.
    expect(fetchCallCount()).toBe(1);
  });
});
