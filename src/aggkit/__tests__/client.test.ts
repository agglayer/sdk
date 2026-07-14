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
      expect(lastFetchUrl()).toBe(`${BASE_URL}/bridge/v1/sync-status`);
    });

    it('trims a trailing slash from baseUrl before appending /bridge/v1', async () => {
      const trailingClient = new AggkitBridgeClient({
        baseUrl: `${BASE_URL}/`,
        networkId: 1,
      });
      mockFetchOnce(loadFixture('sync-status.json'), 200);
      await trailingClient.getSyncStatus();
      expect(lastFetchUrl()).toBe(`${BASE_URL}/bridge/v1/sync-status`);
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
      // current page's array length (design.md §0.5).
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
    it('returns the parsed bare number on success (l1_info_tree_index_valid.json)', async () => {
      mockFetchOnce(loadFixture('l1_info_tree_index_valid.json'), 200);

      const result = await client.getL1InfoTreeIndex({
        networkId: 0,
        depositCount: 1,
      });

      expect(result).toBe(1);
    });

    it('returns null when the deposit has not been included yet (l1_info_tree_index_notfound_error.json, 500)', async () => {
      mockFetchOnce(loadFixture('l1_info_tree_index_notfound_error.json'), 500);

      const result = await client.getL1InfoTreeIndex({
        networkId: 0,
        depositCount: 9999,
      });

      expect(result).toBeNull();
    });

    it('returns null for the L2-origin "not found" 500 variant (l1_info_tree_index_network1_error.json)', async () => {
      mockFetchOnce(loadFixture('l1_info_tree_index_network1_error.json'), 500);

      const result = await client.getL1InfoTreeIndex({
        networkId: 1,
        depositCount: 0,
      });

      expect(result).toBeNull();
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

      expect(result.proof_local_exit_root).toHaveLength(32);
      expect(result.proof_rollup_exit_root).toHaveLength(32);
      expect(result.proof_local_exit_root[0]).toBe(
        '0x341d79031c866046fa536c0e63cd5e7e1246cb76f043f1a4b1ea0986b88c422e'
      );
      expect(result.l1_info_tree_leaf.l1_info_tree_index).toBe(1);
      expect(result.l1_info_tree_leaf.mainnet_exit_root).toBe(
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
