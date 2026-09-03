import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AggkitBridgeClient } from '../client';
import { AggkitBridgeAggregator } from '../aggregator';
import { AggkitApiError } from '../errors';
import type { AggkitActivityItem } from '../types';

// ---------------------------------------------------------------------------
// Cross-network activity (`tracker/v1/activity`) unit tests. This endpoint
// REPLACED the client-side `/bridge/v1` fan-out `AggkitBridgeAggregator
// .getActivity` used before (and the now-removed `getReadyToClaimCount`) —
// see `AggkitActivityResult`'s module doc in `types.ts` for the full
// rationale. There is no live-captured fixture for this endpoint yet; the
// response shape here is built from aggkit's `docs/bridgetracker/API.md`
// `ActivityResponse` schema, matching agglayer-dev-ui's own already-reviewed
// `app/services/activity.ts` port (S-review 2026-08-28).
// ---------------------------------------------------------------------------

function mockResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

function mockFetchOnce(text: string, status: number): void {
  (global.fetch as Mock).mockResolvedValueOnce(mockResponse(text, status));
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
    claimed: 'false',
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
    from_address: [1, 2, 3],
    ...extra,
  });
}

const BASE_URL = 'http://127.0.0.1:33460';
const ADDRESS = '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE';

describe('AggkitBridgeClient.getActivity', () => {
  let client: AggkitBridgeClient;

  beforeEach(() => {
    global.fetch = vi.fn();
    client = new AggkitBridgeClient({ baseUrl: BASE_URL, networkId: 1 });
  });

  describe('URL construction', () => {
    it('builds /tracker/v1/activity/from/{address}?includeTracking=true by default', async () => {
      mockFetchOnce(activityBody([]), 200);
      await client.getActivity({ fromAddress: ADDRESS });
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
  });

  describe('response parsing', () => {
    it('returns bridges + warnings, and drops the useless from_address byte-array echo', async () => {
      const item = makeActivityItem({ claimed: 'true' });
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

    it('preserves the claimed tri-state and an optional joined claim/tracking', async () => {
      const claimedItem = makeActivityItem({
        claimed: 'true',
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

      expect(result.bridges[0]?.claimed).toBe('true');
      expect(result.bridges[0]?.claim?.tx_hash).toBe('0xclaimtx');
    });

    it('surfaces claimed: "error" with a per-kind errors map, never coerced to "false"', async () => {
      const erroredItem = makeActivityItem({
        claimed: 'error',
        errors: { claim: 'isClaimed() call reverted' },
      });
      mockFetchOnce(activityBody([erroredItem]), 200);

      const result = await client.getActivity({ fromAddress: ADDRESS });

      expect(result.bridges[0]?.claimed).toBe('error');
      expect(result.bridges[0]?.errors).toEqual({
        claim: 'isClaimed() call reverted',
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

describe('AggkitBridgeAggregator.getActivity', () => {
  const L2_1_URL = 'http://127.0.0.1:40001';
  const L2_2_URL = 'http://127.0.0.1:40002';

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("picks the first configured network's client — the tracker itself fans out across every configured bridge service server-side", async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL, 2: L2_2_URL },
    });
    const item = makeActivityItem();
    mockFetchOnce(activityBody([item]), 200);

    const result = await aggregator.getActivity({ fromAddress: ADDRESS });

    expect(result.bridges).toEqual([item]);
    expect(lastFetchUrl()).toBe(
      `${L2_1_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=true`
    );
  });

  it('passes includeTracking through unchanged', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL },
    });
    mockFetchOnce(activityBody([]), 200);

    await aggregator.getActivity({
      fromAddress: ADDRESS,
      includeTracking: false,
    });

    expect(lastFetchUrl()).toBe(
      `${L2_1_URL}/tracker/v1/activity/from/${ADDRESS}?includeTracking=false`
    );
  });

  it('rejects instead of silently returning an empty result when no networks are configured', async () => {
    const aggregator = new AggkitBridgeAggregator({ networks: {} });

    await expect(
      aggregator.getActivity({ fromAddress: ADDRESS })
    ).rejects.toThrow(/no networks configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('propagates a genuine tracker failure (AggkitApiError) rather than swallowing it', async () => {
    const aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL },
    });
    mockFetchOnce(
      JSON.stringify({ code: 500, message: 'internal error' }),
      500
    );

    await expect(
      aggregator.getActivity({ fromAddress: ADDRESS })
    ).rejects.toThrow(AggkitApiError);
  });
});
