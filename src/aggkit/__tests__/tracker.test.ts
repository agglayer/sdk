import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AggkitBridgeClient } from '../client';
import { AggkitBridgeAggregator } from '../aggregator';
import { AggkitApiError } from '../errors';
import type { AggkitTrackingData } from '../types';

// ---------------------------------------------------------------------------
// Bridge-tracker (`tracker/v1`) unit tests, run against LIVE fixtures
// captured off a real rc4 enclave
// (`/home/brolygon/repos/plans/bridge-tracker/fixtures/`, copied in as
// `tracker_*.json`) — not the (partially inaccurate) API.md docs. See
// `types.ts`'s tracker-section module doc for the full deviation writeup.
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

function lastFetchUrl(): string {
  const mock = global.fetch as Mock;
  const call = mock.mock.calls[mock.mock.calls.length - 1] as [string, unknown];
  return call[0];
}

const BASE_URL = 'http://127.0.0.1:33460';

describe('AggkitBridgeClient.getBridgeTracking', () => {
  let client: AggkitBridgeClient;

  beforeEach(() => {
    global.fetch = vi.fn();
    client = new AggkitBridgeClient({ baseUrl: BASE_URL, networkId: 1 });
  });

  describe('URL construction', () => {
    it("builds /tracker/v1/network/{id}/tx/{hash} using the client's own networkId by default", async () => {
      mockFetchOnce(loadFixture('tracker_l2l1_running.json'), 200);
      const hash =
        '0xcfbdc931acce665da204150bc025cd76cdbe5566578abaa1ec4ef236fa5c8009';
      await client.getBridgeTracking(hash);
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/network/1/tx/${hash}`
      );
    });

    it("uses the explicit networkId argument over the client's own networkId when passed", async () => {
      mockFetchOnce(loadFixture('tracker_l1l2_finished.json'), 200);
      const hash =
        '0x64b65138996aae61811dac45f10c2baddbf0ab5aae9ef587766b92a23c85791e';
      // client is bound to networkId 1, but the caller explicitly routes L1 (0).
      await client.getBridgeTracking(hash, 0);
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/tracker/v1/network/0/tx/${hash}`
      );
    });
  });

  describe('registered-only tracking data', () => {
    it('parses tracker_registered.json: bridge_status/step_index/all_steps null, error populated', async () => {
      mockFetchOnce(loadFixture('tracker_registered.json'), 200);
      const data = await client.getBridgeTracking(
        '0xdeadbeef00000000000000000000000000000000000000000000000000000000'
      );

      expect(data.tracking_status).toBe('registered');
      expect(data.bridge_status).toBeNull();
      expect(data.step_index).toBeNull();
      expect(data.all_steps).toBeNull();
      expect(data.error).not.toBeNull();
      expect(data.error?.error_type).toBe(0);
      expect(data.error?.error_type_string).toBe('transient');
      expect(data.error?.retry_count).toBe(1);
    });
  });

  describe('giving-up error tracking data', () => {
    it('parses tracker_error_giveup.json: tracking_status "error", error_type 2/"exhausted"', async () => {
      mockFetchOnce(loadFixture('tracker_error_giveup.json'), 200);
      const data = await client.getBridgeTracking(
        '0xdeadbeef00000000000000000000000000000000000000000000000000000000'
      );

      expect(data.tracking_status).toBe('error');
      expect(data.bridge_status).toBeNull();
      expect(data.all_steps).toBeNull();
      expect(data.error).not.toBeNull();
      // numeric + string companion DOES follow the documented convention for error_type.
      expect(data.error?.error_type).toBe(2);
      expect(data.error?.error_type_string).toBe('exhausted');
      expect(data.error?.retry_count).toBe(5);
      expect(data.error?.description).toHaveLength(5);
    });
  });

  describe('L1->L2 typology (4 steps)', () => {
    it('parses a mid-flight run (tracker_l1l2_running.json)', async () => {
      mockFetchOnce(loadFixture('tracker_l1l2_running.json'), 200);
      const data = await client.getBridgeTracking('0xirrelevant');

      expect(data.tracking_status).toBe('running');
      expect(data.bridge_status?.bridge_type).toBe('L1->L2');
      expect(data.bridge_status?.event.leaf_type).toBe('Asset');
      expect(data.step_index).toBe(2);
      expect(data.all_steps).toHaveLength(4);
      // WaitingGERInjection just completed; WaitingClaim now inProgress; the
      // still-`pending` steps carry no start_date/end_date/result keys at all.
      expect(data.all_steps?.[1]?.step_name).toBe('WaitingGERInjection');
      expect(data.all_steps?.[1]?.status).toBe('done');
      expect(data.all_steps?.[2]?.step_name).toBe('WaitingClaim');
      expect(data.all_steps?.[2]?.status).toBe('inProgress');
      expect(data.all_steps?.[3]?.status).toBe('pending');
      expect(data.all_steps?.[3]?.start_date).toBeUndefined();
      expect(data.all_steps?.[3]?.result).toBeUndefined();
    });

    it('parses the terminal `finished` route (tracker_l1l2_finished.json) with correct step count/order/results', async () => {
      mockFetchOnce(loadFixture('tracker_l1l2_finished.json'), 200);
      const data = await client.getBridgeTracking('0xirrelevant');

      expect(data.tracking_status).toBe('finished');
      expect(data.step_index).toBe(3);
      expect(data.all_steps).toHaveLength(4);
      expect(data.all_steps?.map((s) => s.step_name)).toEqual([
        'WaitingGERUpdate',
        'WaitingGERInjection',
        'WaitingClaim',
        'Claimed',
      ]);

      const gerUpdate = data.all_steps?.[0];
      expect(gerUpdate?.result).toMatchObject({
        l1_info_tree_index: 6,
        ger: '0x6c670cb382e5202b19eae5ae3d61491f38c5d4806a4d154410d5370816fbf090',
      });

      const gerInjection = data.all_steps?.[1];
      expect(gerInjection?.result).toEqual({
        ger: '0x6c670cb382e5202b19eae5ae3d61491f38c5d4806a4d154410d5370816fbf090',
      });

      const waitingClaim = data.all_steps?.[2];
      expect(waitingClaim?.result).toMatchObject({
        claim_tx:
          '0x178eed25e7a70d088367b81879bffb7fa800e3f23789d8a11bd05ae78505e3f3',
      });

      const claimed = data.all_steps?.[3];
      expect(claimed?.status).toBe('done');
      expect(claimed?.result).toBeUndefined();
    });
  });

  describe('L2->L1 typology (6 steps)', () => {
    it('parses a mid-flight run (tracker_l2l1_running.json), including certificate + WaitL1SettledGER results', async () => {
      mockFetchOnce(loadFixture('tracker_l2l1_running.json'), 200);
      const data = await client.getBridgeTracking('0xirrelevant');

      expect(data.bridge_status?.bridge_type).toBe('L2->L1');
      expect(data.all_steps).toHaveLength(6);
      // No WaitingGERInjection step for an L1-destination route.
      expect(data.all_steps?.map((s) => s.step_name)).toEqual([
        'WaitingLERUpdate',
        'PendingInclusion',
        'CertificatePending',
        'WaitL1SettledGER',
        'WaitingClaim',
        'Claimed',
      ]);

      const certStep = data.all_steps?.[2];
      expect(certStep?.status).toBe('done');
      // certificate status DOES follow the documented numeric + string convention.
      expect(certStep?.result).toMatchObject({
        status: 4,
        status_string: 'Settled',
        settlement_tx_hash:
          '0x1bf33df3df7e20de949cb8e8dd664c1a928a009d8af2692894a7df9fdc6a76e7',
      });

      const settledGer = data.all_steps?.[3];
      expect(settledGer?.result).toMatchObject({
        l1_info_tree_index: 5,
        has_verify_batches_trusted_aggregator: true,
      });

      expect(data.all_steps?.[4]?.step_name).toBe('WaitingClaim');
      expect(data.all_steps?.[4]?.status).toBe('inProgress');
    });

    it('parses the terminal `finished` route (tracker_l2l1_finished.json) with the manually-submitted claim', async () => {
      mockFetchOnce(loadFixture('tracker_l2l1_finished.json'), 200);
      const data = await client.getBridgeTracking('0xirrelevant');

      expect(data.tracking_status).toBe('finished');
      expect(data.step_index).toBe(5);
      expect(data.all_steps).toHaveLength(6);

      const waitingClaim = data.all_steps?.[4];
      expect(waitingClaim?.result).toMatchObject({
        claim_tx:
          '0x51d247094346142f780378bfb82a1e54b152db5d4035ec4e6937c531c47b0145',
      });

      const pendingInclusion = data.all_steps?.[1];
      expect(pendingInclusion?.result).toMatchObject({
        certificate_id:
          '0xfd92b4854c0364e0a9e8e3bade6bbcc0873a6be917321320d7e2f24e24f7131f',
        previous_ler:
          '0xfd107fe3ba1c4de7139e4ca5d666ec90a7df9698c926f585611eac31ce13192f',
      });
    });
  });

  describe('L2->L2 typology (7 steps)', () => {
    it('parses a mid-flight run (tracker_l2l2_running.json) with the WaitingGERInjection step present', async () => {
      mockFetchOnce(loadFixture('tracker_l2l2_running.json'), 200);
      const data = await client.getBridgeTracking('0xirrelevant');

      expect(data.bridge_status?.bridge_type).toBe('L2->L2');
      expect(data.all_steps).toHaveLength(7);
      expect(data.all_steps?.map((s) => s.step_name)).toEqual([
        'WaitingLERUpdate',
        'PendingInclusion',
        'CertificatePending',
        'WaitL1SettledGER',
        'WaitingGERInjection',
        'WaitingClaim',
        'Claimed',
      ]);
      expect(data.all_steps?.[4]?.step_name).toBe('WaitingGERInjection');
      expect(data.all_steps?.[4]?.status).toBe('inProgress');
    });

    it('parses the terminal `finished` route (tracker_l2l2_finished.json) with correct step count/order/results', async () => {
      mockFetchOnce(loadFixture('tracker_l2l2_finished.json'), 200);
      const data = await client.getBridgeTracking('0xirrelevant');

      expect(data.tracking_status).toBe('finished');
      expect(data.step_index).toBe(6);
      expect(data.all_steps).toHaveLength(7);

      const gerInjection = data.all_steps?.[4];
      expect(gerInjection?.step_name).toBe('WaitingGERInjection');
      expect(gerInjection?.result).toEqual({
        ger: '0x6989b12606017b91d6defe2184415b5071fb7004e8daee4b3b82efd5e54045ff',
      });

      const waitingClaim = data.all_steps?.[5];
      expect(waitingClaim?.result).toMatchObject({
        claim_tx:
          '0xea2424b0837070a37feba683b1994357fb92bc3b55116aae528a0f777d7c937c',
      });

      const claimed = data.all_steps?.[6];
      expect(claimed?.status).toBe('done');
      expect(claimed?.result).toBeUndefined();
    });
  });

  describe('400 ErrorData (tracker error shape, not the bridge-service {"error"} shape)', () => {
    it('throws AggkitApiError with the {code,message} body parsed as the error message', async () => {
      mockFetchOnce(loadFixture('tracker_error_400.json'), 400);

      let caught: unknown;
      try {
        await client.getBridgeTracking('not-a-valid-hash');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AggkitApiError);
      expect((caught as AggkitApiError).httpStatus).toBe(400);
      expect((caught as AggkitApiError).message).toBe(
        'invalid tx_hash parameter'
      );
      expect((caught as AggkitApiError).endpoint).toBe(
        '/tracker/v1/network/{network_id}/tx/{tx_hash}'
      );
    });
  });
});

describe('AggkitBridgeAggregator.getBridgeTracking', () => {
  const L2_1_URL = 'http://127.0.0.1:40001';
  const L2_2_URL = 'http://127.0.0.1:40002';
  let aggregator: AggkitBridgeAggregator;

  beforeEach(() => {
    global.fetch = vi.fn();
    aggregator = new AggkitBridgeAggregator({
      networks: { 1: L2_1_URL, 2: L2_2_URL },
    });
  });

  it('routes network 0 (L1) through the first configured L2 client but puts network 0 in the URL path', async () => {
    mockFetchOnce(loadFixture('tracker_l1l2_finished.json'), 200);
    const hash =
      '0x64b65138996aae61811dac45f10c2baddbf0ab5aae9ef587766b92a23c85791e';

    const data: AggkitTrackingData = await aggregator.getBridgeTracking(
      0,
      hash
    );

    expect(data.tracking_status).toBe('finished');
    // Hits the network-1-configured client's base URL (first configured
    // network — L1 has no dedicated instance)...
    expect(lastFetchUrl()).toContain(L2_1_URL);
    // ...but the URL path itself says network 0, not network 1.
    expect(lastFetchUrl()).toBe(`${L2_1_URL}/tracker/v1/network/0/tx/${hash}`);
  });

  it('routes a non-L1 network directly to its own configured client, with that networkId in the URL path', async () => {
    mockFetchOnce(loadFixture('tracker_l2l2_finished.json'), 200);
    const hash =
      '0x66a20ab10e92748f7ee30f9a487e262a673b790df365bf3067a59c8b71fb2fe8';

    const data = await aggregator.getBridgeTracking(1, hash);

    expect(data.bridge_status?.bridge_type).toBe('L2->L2');
    expect(lastFetchUrl()).toBe(`${L2_1_URL}/tracker/v1/network/1/tx/${hash}`);
  });
});
