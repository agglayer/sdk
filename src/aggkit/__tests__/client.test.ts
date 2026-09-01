import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AggkitBridgeClient } from '../client';
import { AggkitApiError } from '../errors';

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

describe('AggkitBridgeClient', () => {
  let client: AggkitBridgeClient;

  beforeEach(() => {
    global.fetch = vi.fn();
    client = new AggkitBridgeClient({ baseUrl: BASE_URL, networkId: 1 });
  });

  describe('URL construction', () => {
    it('appends /bridge/v1 to the base URL', async () => {
      mockFetchOnce(loadFixture('sync-status.json'), 200);
      await client.getSyncStatus();
      // getSyncStatus sends network_id explicitly (aggkit-proxy 400s an
      // unqualified /sync-status request).
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/bridge/v1/sync-status?network_id=1`
      );
    });

    it('trims a trailing slash from baseUrl before appending /bridge/v1', async () => {
      const trailingClient = new AggkitBridgeClient({
        baseUrl: `${BASE_URL}/`,
        networkId: 1,
      });
      mockFetchOnce(loadFixture('sync-status.json'), 200);
      await trailingClient.getSyncStatus();
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/bridge/v1/sync-status?network_id=1`
      );
    });

    it('trims multiple trailing slashes from baseUrl before appending /bridge/v1', async () => {
      const trailingClient = new AggkitBridgeClient({
        baseUrl: `${BASE_URL}///`,
        networkId: 1,
      });
      mockFetchOnce(loadFixture('sync-status.json'), 200);
      await trailingClient.getSyncStatus();
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/bridge/v1/sync-status?network_id=1`
      );
    });

    it('trims a very long run of trailing slashes without hanging', async () => {
      // Regression test for the trailing-slash trim (formerly `/\/+$/`,
      // flagged by CodeQL as a potential ReDoS source on library-supplied
      // `baseUrl`). Asserts both correctness and that a long adversarial
      // input resolves promptly.
      const manySlashes = `${BASE_URL}${'/'.repeat(50_000)}`;
      const trailingClient = new AggkitBridgeClient({
        baseUrl: manySlashes,
        networkId: 1,
      });
      mockFetchOnce(loadFixture('sync-status.json'), 200);
      await trailingClient.getSyncStatus();
      expect(lastFetchUrl()).toBe(
        `${BASE_URL}/bridge/v1/sync-status?network_id=1`
      );
    });

    it('requests the root URL (not /bridge/v1) for getHealth', async () => {
      mockFetchOnce(loadFixture('health.json'), 200);
      await client.getHealth();
      expect(lastFetchUrl()).toBe(`${BASE_URL}/`);
    });
  });

  describe('getBridges', () => {
    it('parses bridges_network0.json and preserves global_index as a BigInt-safe string', async () => {
      mockFetchOnce(loadFixture('bridges_network0.json'), 200);

      const result = await client.getBridges({ networkId: 0 });

      expect(result.count).toBe(6);
      expect(result.bridges).toHaveLength(6);

      const first = result.bridges[0];
      expect(first).toBeDefined();
      // Bare JSON number 18446744073709551621 exceeds Number.MAX_SAFE_INTEGER;
      // must be carried as a string, not corrupted into a JS number.
      expect(typeof first?.global_index).toBe('string');
      expect(first?.global_index).toBe('18446744073709551621');
      expect(first?.deposit_count).toBe(5);
      expect(first?.origin_network).toBe(0);
      expect(first?.destination_network).toBe(1);
      expect(first?.amount).toBe('1783931047');
      expect(first?.bridge_hash).toBe(
        '0xc74023c27b3672f939979f46a124c11971060ccb20f0a235da3bc0ec35dbb253'
      );

      // BigInt(...) must not throw / lose precision on the returned string.
      expect(BigInt(first?.global_index ?? '0')).toBe(18446744073709551621n);
    });

    it('parses bridges_network1.json (L2-origin, small global_index values)', async () => {
      mockFetchOnce(loadFixture('bridges_network1.json'), 200);

      const result = await client.getBridges({ networkId: 1 });

      expect(result.count).toBe(3);
      expect(result.bridges).toHaveLength(3);
      expect(result.bridges[0]?.global_index).toBe('2');
      expect(result.bridges[0]?.deposit_count).toBe(2);
      expect(result.bridges[0]?.destination_network).toBe(0);
    });

    it('serializes fromAddress into the from_address query param', async () => {
      mockFetchOnce(loadFixture('bridges_from_address.json'), 200);

      const result = await client.getBridges({
        networkId: 1,
        fromAddress: '0x3C4d3AAB4356120117E88225e649f0A7ae0401DE',
      });

      expect(result.count).toBe(4);
      const url = lastFetchUrl();
      expect(url).toContain('network_id=1');
      expect(url).toContain(
        'from_address=0x3C4d3AAB4356120117E88225e649f0A7ae0401DE'
      );
    });

    it('supports pagination: page_number/page_size are sent and count is the TOTAL across pages', async () => {
      mockFetchOnce(loadFixture('bridges_page1.json'), 200);
      const page1 = await client.getBridges({
        networkId: 0,
        pageNumber: 1,
        pageSize: 2,
      });
      expect(lastFetchUrl()).toContain('page_number=1');
      expect(lastFetchUrl()).toContain('page_size=2');
      expect(page1.bridges).toHaveLength(2);
      expect(page1.count).toBe(7);
      expect(page1.bridges[0]?.deposit_count).toBe(6);
      expect(page1.bridges[1]?.deposit_count).toBe(5);

      mockFetchOnce(loadFixture('bridges_page2.json'), 200);
      const page2 = await client.getBridges({
        networkId: 0,
        pageNumber: 2,
        pageSize: 2,
      });
      expect(lastFetchUrl()).toContain('page_number=2');
      expect(lastFetchUrl()).toContain('page_size=2');
      expect(page2.bridges).toHaveLength(2);
      // count is the TOTAL matching count, identical across pages, NOT the
      // current page's array length.
      expect(page2.count).toBe(7);
      expect(page2.bridges[0]?.deposit_count).toBe(4);
      expect(page2.bridges[1]?.deposit_count).toBe(3);
    });

    it('serializes networkIds (destination filter) as a CSV network_ids param', async () => {
      mockFetchOnce(loadFixture('bridges_network0.json'), 200);
      await client.getBridges({ networkId: 0, networkIds: [1, 2, 3] });
      expect(lastFetchUrl()).toContain('network_ids=1%2C2%2C3');
    });

    it('throws RangeError when pageSize exceeds 200', async () => {
      await expect(
        client.getBridges({ networkId: 0, pageSize: 201 })
      ).rejects.toThrow(RangeError);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws RangeError when networkIds has more than 5 entries', async () => {
      await expect(
        client.getBridges({ networkId: 0, networkIds: [1, 2, 3, 4, 5, 6] })
      ).rejects.toThrow(RangeError);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws AggkitApiError(400) for error_unsupported_network_id.json', async () => {
      mockFetchOnce(loadFixture('error_unsupported_network_id.json'), 400);

      let caught: unknown;
      try {
        await client.getBridges({ networkId: 2 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggkitApiError);
      expect((caught as AggkitApiError).httpStatus).toBe(400);
      expect((caught as AggkitApiError).message).toBe(
        'unsupported network id: 2'
      );
      expect((caught as AggkitApiError).endpoint).toBe('/bridges');
    });

    it('throws AggkitApiError(400) for error_missing_network_id.json', async () => {
      mockFetchOnce(loadFixture('error_missing_network_id.json'), 400);

      let caught: unknown;
      try {
        // networkId is required by the TS signature, but the server enforces
        // it too; simulate the 400 body aggkit returns when it's absent.
        await client.getBridges({ networkId: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggkitApiError);
      expect((caught as AggkitApiError).httpStatus).toBe(400);
      expect((caught as AggkitApiError).message).toBe(
        'network_id is mandatory'
      );
    });
  });

  describe('getClaims', () => {
    it('parses claims_network1.json — global_index arrives as a JSON string already and is preserved', async () => {
      mockFetchOnce(loadFixture('claims_network1.json'), 200);

      const result = await client.getClaims({ networkId: 1 });

      expect(result.count).toBe(5);
      expect(result.claims).toHaveLength(5);
      const first = result.claims[0];
      expect(typeof first?.global_index).toBe('string');
      expect(first?.global_index).toBe('18446744073709551621');
      expect(first?.from_address).toBe('');
      expect(first?.is_message).toBe(false);
      expect(first?.proof_local_exit_root).toBeUndefined();
    });

    it('parses claims_network0.json (empty — no L2->L1 autoclaim in this dataset)', async () => {
      mockFetchOnce(loadFixture('claims_network0.json'), 200);

      const result = await client.getClaims({ networkId: 0 });

      expect(result.count).toBe(0);
      expect(result.claims).toEqual([]);
    });

    it('parses claims_network1_all_fields.json — includeAllFields adds proof arrays', async () => {
      mockFetchOnce(loadFixture('claims_network1_all_fields.json'), 200);

      const result = await client.getClaims({
        networkId: 1,
        includeAllFields: true,
      });

      expect(lastFetchUrl()).toContain('include_all_fields=true');
      expect(result.claims).toHaveLength(5);
      const first = result.claims[0];
      expect(first?.proof_local_exit_root).toHaveLength(32);
      expect(first?.proof_rollup_exit_root).toHaveLength(32);
      expect(first?.proof_local_exit_root?.[0]).toBe(
        '0x0aaf70344d0a776294e609094fcd63829819a5800b7751275e8b055c6e721df3'
      );
    });

    it('parses claims_network1_global_index_filter.json and sends global_index as a query param', async () => {
      mockFetchOnce(
        loadFixture('claims_network1_global_index_filter.json'),
        200
      );

      const result = await client.getClaims({
        networkId: 1,
        globalIndex: '18446744073709551621',
      });

      expect(lastFetchUrl()).toContain('global_index=18446744073709551621');
      expect(result.count).toBe(1);
      expect(result.claims[0]?.global_index).toBe('18446744073709551621');
    });
  });

  describe('getL1InfoTreeIndex', () => {
    it('returns { ready: true, value } with the parsed bare number on success (l1_info_tree_index_valid.json)', async () => {
      mockFetchOnce(loadFixture('l1_info_tree_index_valid.json'), 200);

      const result = await client.getL1InfoTreeIndex({
        networkId: 0,
        depositCount: 1,
      });

      expect(result).toEqual({ ready: true, value: 1 });
    });

    it("returns { ready: false, reason: 'SOURCE_NOT_ON_L1_INFO_TREE' } — NOT a throw — when the deposit has not been included yet (l1_info_tree_index_notfound_error.json, 500) (comment 3847523270)", async () => {
      mockFetchOnce(loadFixture('l1_info_tree_index_notfound_error.json'), 500);

      const result = await client.getL1InfoTreeIndex({
        networkId: 0,
        depositCount: 9999,
      });

      expect(result).toEqual({
        ready: false,
        reason: 'SOURCE_NOT_ON_L1_INFO_TREE',
        detail: expect.any(String),
      });
      // aggkit's own wording is propagated verbatim for logging/display.
      expect(result.ready).toBe(false);
      if (!result.ready) {
        expect(result.detail.length).toBeGreaterThan(0);
      }
    });

    it('throws AggkitApiError — does NOT return the not-ready union — for a bare "not found" 500 (l1_info_tree_index_network1_error.json): the old loose pattern list treated this as not-ready, but a bare "not found" is a trap (comment 3862896539) — it is aggkit\'s wrapped `db.ErrNotFound`, indistinguishable in prose from a genuine unrelated failure', async () => {
      mockFetchOnce(loadFixture('l1_info_tree_index_network1_error.json'), 500);

      await expect(
        client.getL1InfoTreeIndex({ networkId: 1, depositCount: 0 })
      ).rejects.toMatchObject({
        httpStatus: 500,
        endpoint: '/l1-info-tree-index',
        message: expect.stringContaining('not found'),
      });
    });

    it('returns { ready: false, reason: \'SOURCE_NOT_ON_L1_INFO_TREE\' } for the rc6 wire shape: a 404 with the fixed "is not available yet, retry later" prefix (l1_info_tree_index_rc6_not_available_404.json, aggkit #1794 / v0.11.0-rc6, comment 3862896539)', async () => {
      mockFetchOnce(
        loadFixture('l1_info_tree_index_rc6_not_available_404.json'),
        404
      );

      const result = await client.getL1InfoTreeIndex({
        networkId: 1,
        depositCount: 50,
      });

      expect(result).toEqual({
        ready: false,
        reason: 'SOURCE_NOT_ON_L1_INFO_TREE',
        detail: expect.stringContaining('is not available yet, retry later'),
      });
    });

    it('throws AggkitApiError — does NOT return the not-ready union — for the aggkit-proxy\'s OWN routing-failure 404 arriving on THIS endpoint (error_404_unknown_network.json): the proxy sits in front of every route, so its "bridge service url not found for network" prose must never be misclassified as not-ready, even now that 404 is a recognised not-ready carrier (comment 3862896539)', async () => {
      mockFetchOnce(loadFixture('error_404_unknown_network.json'), 404);

      await expect(
        client.getL1InfoTreeIndex({ networkId: 9, depositCount: 1 })
      ).rejects.toMatchObject({
        httpStatus: 404,
        endpoint: '/l1-info-tree-index',
        message: 'bridge service url not found for network: network 9',
      });
    });

    it("returns { ready: false, reason: 'SYNCER_INCONSISTENT' } for the rc6 wire shape: a 503 while a syncer resolves a reorg (l1_info_tree_index_rc6_syncer_inconsistent_503.json, v0.11.0-rc6, comment 3862896539)", async () => {
      mockFetchOnce(
        loadFixture('l1_info_tree_index_rc6_syncer_inconsistent_503.json'),
        503
      );

      const result = await client.getL1InfoTreeIndex({
        networkId: 1,
        depositCount: 50,
      });

      expect(result).toEqual({
        ready: false,
        reason: 'SYNCER_INCONSISTENT',
        detail: expect.stringContaining('a syncer is temporarily inconsistent'),
      });
    });

    it('throws AggkitApiError for a 503 that does NOT match the syncer-inconsistent prefix (a genuine/unrelated 503, e.g. a different handler\'s "syncer is not available" or a proxy outage, stays an error)', async () => {
      mockFetchOnce(
        JSON.stringify({ error: 'L1 bridge syncer is not available' }),
        503
      );

      await expect(
        client.getL1InfoTreeIndex({ networkId: 1, depositCount: 50 })
      ).rejects.toMatchObject({
        httpStatus: 503,
        endpoint: '/l1-info-tree-index',
        message: 'L1 bridge syncer is not available',
      });
    });

    it('throws AggkitApiError for a 500 whose body does NOT match the not-ready patterns (a genuine server error stays an error)', async () => {
      mockFetchOnce(
        JSON.stringify({ error: 'unexpected internal database failure' }),
        500
      );

      await expect(
        client.getL1InfoTreeIndex({ networkId: 1, depositCount: 1 })
      ).rejects.toMatchObject({
        httpStatus: 500,
        endpoint: '/l1-info-tree-index',
        message: 'unexpected internal database failure',
      });
    });

    it('throws AggkitApiError for a non-numeric 2xx body (protocol failure, not a waiting state)', async () => {
      mockFetchOnce('not-a-number', 200);

      await expect(
        client.getL1InfoTreeIndex({ networkId: 1, depositCount: 1 })
      ).rejects.toBeInstanceOf(AggkitApiError);
    });

    it('throws AggkitApiError for a 400 on this endpoint (does not swallow non-500 errors)', async () => {
      mockFetchOnce(loadFixture('error_missing_network_id.json'), 400);

      await expect(
        client.getL1InfoTreeIndex({ networkId: 0, depositCount: 1 })
      ).rejects.toMatchObject({
        httpStatus: 400,
        endpoint: '/l1-info-tree-index',
      });
    });
  });

  describe('getClaimProof', () => {
    it('parses claim_proof_valid.json', async () => {
      mockFetchOnce(loadFixture('claim_proof_valid.json'), 200);

      const result = await client.getClaimProof({
        networkId: 0,
        leafIndex: 1,
        depositCount: 1,
      });

      expect(result.ready).toBe(true);
      if (!result.ready) {
        throw new Error('expected a ready claim-proof result');
      }
      expect(result.value.proof_local_exit_root).toHaveLength(32);
      expect(result.value.proof_rollup_exit_root).toHaveLength(32);
      expect(result.value.proof_local_exit_root[0]).toBe(
        '0x341d79031c866046fa536c0e63cd5e7e1246cb76f043f1a4b1ea0986b88c422e'
      );
      expect(result.value.l1_info_tree_leaf.l1_info_tree_index).toBe(1);
      expect(result.value.l1_info_tree_leaf.mainnet_exit_root).toBe(
        '0x2d60988d34d8dea9686f4ba38ba813457e424cf6cf98836727662bd2b83c6939'
      );

      const url = lastFetchUrl();
      expect(url).toContain('network_id=0');
      expect(url).toContain('leaf_index=1');
      expect(url).toContain('deposit_count=1');
    });

    it('throws AggkitApiError(500) for claim_proof_error_badindex.json', async () => {
      mockFetchOnce(loadFixture('claim_proof_error_badindex.json'), 500);

      await expect(
        client.getClaimProof({ networkId: 0, leafIndex: 9999, depositCount: 1 })
      ).rejects.toMatchObject({
        httpStatus: 500,
        endpoint: '/claim-proof',
        message:
          'failed to get l1 info tree leaf for index 9999: sql: no rows in result set',
      });
    });

    it('throws AggkitApiError(400) for claim_proof_error_missing_param.json', async () => {
      mockFetchOnce(loadFixture('claim_proof_error_missing_param.json'), 400);

      let caught: unknown;
      try {
        // depositCount required by the TS signature; simulating the server's
        // 400 response to a request missing it.
        await client.getClaimProof({
          networkId: 0,
          leafIndex: 1,
          depositCount: 1,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggkitApiError);
      expect((caught as AggkitApiError).httpStatus).toBe(400);
      expect((caught as AggkitApiError).message).toBe(
        'deposit_count is mandatory'
      );
    });
  });

  describe('getInjectedL1InfoLeaf', () => {
    it('parses the 200 body (l2l2_165346035Z_injected_l1_info_leaf_7.json) — post-injection', async () => {
      mockFetchOnce(
        loadFixture('l2l2_165346035Z_injected_l1_info_leaf_7.json'),
        200
      );

      const result = await client.getInjectedL1InfoLeaf({
        networkId: 2,
        leafIndex: 7,
      });

      expect(result.ready).toBe(true);
      if (!result.ready) {
        throw new Error('expected a ready injected-leaf result');
      }
      expect(result.value.l1_info_tree_index).toBe(7);
      expect(result.value.mainnet_exit_root).toBe(
        '0xb95baa2123d348ef6e6bcce08109f2232881723940ae41612bc4a7801f0ecba2'
      );
      const url = lastFetchUrl();
      expect(url).toContain('network_id=2');
      expect(url).toContain('leaf_index=7');
    });

    it('returns { ready: false, reason: \'DESTINATION_GER_NOT_INJECTED\' } — NOT a throw — for the documented 404 "not injected" branch (l2l2_165338016Z_injected_l1_info_leaf_7.json) — premature window', async () => {
      mockFetchOnce(
        loadFixture('l2l2_165338016Z_injected_l1_info_leaf_7.json'),
        404
      );

      const result = await client.getInjectedL1InfoLeaf({
        networkId: 2,
        leafIndex: 7,
      });

      expect(result).toEqual({
        ready: false,
        reason: 'DESTINATION_GER_NOT_INJECTED',
        detail: expect.stringMatching(/not injected/),
      });
    });

    it('throws (does NOT return the not-ready union) for the proxy "bridge service url not found" 404 (error_404_unknown_network.json) — the two 404 shapes collide, so "not injected" must be matched by message', async () => {
      mockFetchOnce(loadFixture('error_404_unknown_network.json'), 404);

      await expect(
        client.getInjectedL1InfoLeaf({ networkId: 9, leafIndex: 7 })
      ).rejects.toMatchObject({
        httpStatus: 404,
        endpoint: '/injected-l1-info-leaf',
        message: 'bridge service url not found for network: network 9',
      });
    });

    it('throws AggkitApiError for a 502 (proxy backend unreachable, error_502_stopped_backend.json)', async () => {
      mockFetchOnce(loadFixture('error_502_stopped_backend.json'), 502);

      await expect(
        client.getInjectedL1InfoLeaf({ networkId: 2, leafIndex: 7 })
      ).rejects.toMatchObject({
        httpStatus: 502,
        endpoint: '/injected-l1-info-leaf',
      });
    });
  });

  describe('getTokenMappings', () => {
    it('parses token_mappings_network1.json (empty — native-only enclave)', async () => {
      mockFetchOnce(loadFixture('token_mappings_network1.json'), 200);

      const result = await client.getTokenMappings({ networkId: 1 });

      expect(result.count).toBe(0);
      expect(result.token_mappings).toEqual([]);
    });

    it('throws RangeError when pageSize exceeds 200', async () => {
      await expect(
        client.getTokenMappings({ networkId: 1, pageSize: 500 })
      ).rejects.toThrow(RangeError);
    });
  });

  describe('getSyncStatus', () => {
    it('parses sync-status.json', async () => {
      mockFetchOnce(loadFixture('sync-status.json'), 200);

      const result = await client.getSyncStatus();

      expect(result.l1_info).toEqual({
        contract_deposit_count: 6,
        synchronized_deposit_count: 6,
        is_synced: true,
        is_active: true,
      });
      expect(result.l2_info).toEqual({
        contract_deposit_count: 3,
        synchronized_deposit_count: 3,
        is_synced: true,
        is_active: true,
      });
    });

    it('sends network_id — required for aggkit-proxy, which 400s "missing mandatory query parameter: network_id" on an unqualified request', async () => {
      const network2Client = new AggkitBridgeClient({
        baseUrl: BASE_URL,
        networkId: 2,
      });
      mockFetchOnce(loadFixture('sync_status_network2.json'), 200);

      const result = await network2Client.getSyncStatus();

      expect(lastFetchUrl()).toContain('network_id=2');
      expect(result.l1_info.is_synced).toBe(true);
      expect(result.l2_info.is_synced).toBe(true);
    });
  });

  describe('getHealth', () => {
    it('parses health.json', async () => {
      mockFetchOnce(loadFixture('health.json'), 200);

      const result = await client.getHealth();

      expect(result.status).toBe('ok');
      expect(result.version).toBe('421ba23');
    });
  });

  describe('networkId property', () => {
    it('exposes the configured networkId', () => {
      const n = new AggkitBridgeClient({ baseUrl: BASE_URL, networkId: 42 });
      expect(n.networkId).toBe(42);
    });
  });
});
