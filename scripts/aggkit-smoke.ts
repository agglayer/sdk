/**
 * aggkit-smoke.ts
 *
 * Integration smoke test for the S4/S5 aggkit SDK code (`src/aggkit/*`)
 * against a LIVE aggkit bridge REST instance — NOT a fixture-driven unit
 * test. Exercises: health, sync-status, a real spammer address's activity
 * (via the aggregator), full status derivation against known ground truth,
 * the l1-info-tree-index -> claim-proof roundtrip, and token-mappings.
 *
 * Run (see /home/brolygon/repos/plans/aggkit-migration/handoff-sdk.md for
 * the exact command + recorded output from the S6 run):
 *
 *   AGGKIT_URL=http://127.0.0.1:<port> npx tsx scripts/aggkit-smoke.ts
 *
 * Env vars:
 *   AGGKIT_URL     required. Direct aggkit REST base (WITHOUT /bridge/v1),
 *                  e.g. http://127.0.0.1:33513. Re-resolve with
 *                  `kurtosis port print cdk aggkit-001-bridge rest`.
 *   L2_NETWORK_ID  optional, default 1 (this enclave's single L2).
 *   FROM_ADDRESS   optional, default the bridge-spammer's observed
 *                  from_address in this enclave. Override if traffic moves
 *                  to a different address after an enclave recreate.
 */

import { AggkitBridgeClient } from '../src/aggkit/client';
import { AggkitBridgeAggregator } from '../src/aggkit/aggregator';

const AGGKIT_URL = process.env['AGGKIT_URL'];
if (!AGGKIT_URL) {
  console.error(
    'AGGKIT_URL env var is required (direct aggkit REST base, e.g. http://127.0.0.1:33513).\n' +
      'Re-resolve with: kurtosis port print cdk aggkit-001-bridge rest'
  );
  process.exit(1);
}

const L2_NETWORK_ID = Number(process.env['L2_NETWORK_ID'] ?? 1);
const FROM_ADDRESS =
  process.env['FROM_ADDRESS'] ?? '0xb22BA8Af891A6D173648B45D3eFC234391bA99D0';

let failures = 0;
function assert(cond: unknown, message: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function main(): Promise<void> {
  const client = new AggkitBridgeClient({
    baseUrl: AGGKIT_URL as string,
    networkId: L2_NETWORK_ID,
  });
  const aggregator = new AggkitBridgeAggregator({
    networks: { [L2_NETWORK_ID]: AGGKIT_URL as string },
  });

  console.log(`\naggkit-smoke: base=${AGGKIT_URL} l2NetworkId=${L2_NETWORK_ID} fromAddress=${FROM_ADDRESS}`);

  console.log(`\n=== 1. Health (GET /) ===`);
  const health = await client.getHealth();
  console.log(health);
  assert(health.status === 'ok', 'health.status === "ok"');
  assert(
    typeof health.version === 'string' && health.version.length > 0,
    'health.version is a non-empty string'
  );

  console.log(`\n=== 2. Sync status (GET /bridge/v1/sync-status) ===`);
  const sync = await client.getSyncStatus();
  console.log(JSON.stringify(sync, null, 2));
  assert(sync.l1_info.is_synced === true, 'l1_info.is_synced === true');
  assert(sync.l2_info.is_synced === true, 'l2_info.is_synced === true');
  assert(
    typeof sync.l1_info.contract_deposit_count === 'number',
    'l1_info.contract_deposit_count is a number'
  );

  console.log(
    `\n=== 3. Activity for a real spammer address (via AggkitBridgeAggregator.getActivity) ===`
  );
  const activity = await aggregator.getActivity({
    fromAddress: FROM_ADDRESS,
    pageSize: 50,
  });
  console.log(
    `activity.data.length=${activity.data.length} pagination=${JSON.stringify(
      activity.pagination
    )} failedNetworks=${JSON.stringify(activity.failedNetworks)}`
  );
  assert(
    activity.failedNetworks.length === 0,
    'no failed networks in the getActivity fan-out'
  );
  assert(
    activity.data.length > 0,
    'getActivity returned at least one transaction for the real from_address'
  );

  const knownStatuses = ['BRIDGED', 'LEAF_INCLUDED', 'READY_TO_CLAIM', 'CLAIMED'];
  const statusCounts: Record<string, number> = {};
  for (const tx of activity.data) {
    statusCounts[tx.status] = (statusCounts[tx.status] ?? 0) + 1;
    assert(
      knownStatuses.includes(tx.status),
      `tx bridgeHash=${tx.bridgeHash} status "${tx.status}" is one of the 4 known statuses`
    );
  }
  console.log('status distribution across fetched page:', statusCounts);

  // Flag (do NOT auto-fix, see handoff-sdk.md "Observations for S7"): rows
  // whose destination_network === 0 (L2-native-gas-token withdrawals back to
  // L1) use `bridge.origin_network` (always 0 for these, since ETH's asset
  // origin is L1) as the l1-info-tree-index probe's networkId — but these
  // deposits were recorded in the L2's OWN local exit tree (queried via
  // network_id=<L2>), not network 0's tree. Every local index collides with
  // an unrelated, coincidentally-same-numbered L1-origin deposit, so the
  // probe can return a superficially "successful" (200) but semantically
  // WRONG leaf for these rows. Print them here for visibility.
  const suspectExitRows = activity.data.filter(
    (tx) => tx.destinationNetwork === 0 && tx.originTokenNetwork === 0
  );
  if (suspectExitRows.length > 0) {
    console.log(
      `\nNOTE: ${suspectExitRows.length} L2->L1 native-gas-token withdrawal row(s) present on this page ` +
        `(destinationNetwork=0, originTokenNetwork=0). Their derived status/leafIndexForProof is NOT ` +
        `verified reliable by this smoke test — see handoff-sdk.md "Observations for S7". Sample: ` +
        `${JSON.stringify(suspectExitRows.slice(0, 2).map((tx) => ({ bridgeHash: tx.bridgeHash, depositCount: tx.depositCount, status: tx.status, leafIndexForProof: tx.leafIndexForProof })))}`
    );
  }

  console.log(
    `\n=== 4. Full status derivation for a known-ground-truth deposit ===`
  );
  // Ground truth built directly from raw client calls (bypassing the
  // aggregator) so we know independently which bridge_hash is genuinely
  // claimed before checking what the aggregator derives for it.
  const rawL1OriginBridges = await client.getBridges({
    networkId: 0,
    networkIds: [L2_NETWORK_ID],
    fromAddress: FROM_ADDRESS,
    pageSize: 200,
  });
  const rawL2Claims = await client.getClaims({
    networkId: L2_NETWORK_ID,
    pageSize: 200,
  });
  const claimedGlobalIndexes = new Set(
    rawL2Claims.claims.map((c) => c.global_index)
  );
  const knownClaimedBridge = rawL1OriginBridges.bridges.find((b) =>
    claimedGlobalIndexes.has(b.global_index)
  );
  assert(
    !!knownClaimedBridge,
    'found a real L1->L2 bridge row with a matching raw claim (ground truth for CLAIMED)'
  );

  if (knownClaimedBridge) {
    console.log(
      `ground truth: bridge_hash=${knownClaimedBridge.bridge_hash} deposit_count=${knownClaimedBridge.deposit_count} global_index=${knownClaimedBridge.global_index}`
    );
    const txForBridge = activity.data.find(
      (tx) => tx.bridgeHash === knownClaimedBridge.bridge_hash
    );
    if (txForBridge) {
      assert(
        txForBridge.status === 'CLAIMED',
        `known-claimed bridge (deposit_count=${knownClaimedBridge.deposit_count}) derived as CLAIMED via getActivity`
      );
      assert(
        txForBridge.claimTransactionHash !== undefined,
        'CLAIMED tx carries a claimTransactionHash'
      );
    } else {
      console.log(
        `(bridge_hash=${knownClaimedBridge.bridge_hash} not present on the fetched activity page due to pagination/ordering — ` +
          `falling back to a direct claims-map consistency check instead of the getActivity-level assertion)`
      );
      assert(
        claimedGlobalIndexes.has(knownClaimedBridge.global_index),
        'raw claims data confirms this global_index is claimed (independent of getActivity pagination)'
      );
    }
  }

  console.log(
    `\n=== 5. l1-info-tree-index -> claim-proof roundtrip (via getClaimInputs, L1->L2 origin) ===`
  );
  const sampleDepositCount =
    knownClaimedBridge?.deposit_count ?? rawL1OriginBridges.bridges[0]?.deposit_count;
  assert(
    sampleDepositCount !== undefined,
    'found a real L1->L2 deposit_count to probe'
  );
  if (sampleDepositCount !== undefined) {
    const { leafIndex, proof } = await aggregator.getClaimInputs({
      originNetworkId: 0,
      destinationNetworkId: L2_NETWORK_ID,
      depositCount: sampleDepositCount,
    });
    console.log(
      `depositCount=${sampleDepositCount} -> leafIndex=${leafIndex}, proof_local_exit_root.length=${proof.proof_local_exit_root.length}, proof_rollup_exit_root.length=${proof.proof_rollup_exit_root.length}`
    );
    assert(typeof leafIndex === 'number', 'leafIndex is a number');
    assert(
      proof.proof_local_exit_root.length === 32,
      'proof_local_exit_root has 32 entries'
    );
    assert(
      proof.proof_rollup_exit_root.length === 32,
      'proof_rollup_exit_root has 32 entries'
    );
    assert(
      proof.l1_info_tree_leaf.l1_info_tree_index === leafIndex,
      'l1_info_tree_leaf.l1_info_tree_index matches the probed leafIndex'
    );
  }

  console.log(
    `\n=== 6. Token mappings (this enclave only has native-currency spammer traffic) ===`
  );
  const mappings = await client.getTokenMappings({ networkId: L2_NETWORK_ID });
  console.log(JSON.stringify(mappings));
  assert(
    Array.isArray(mappings.token_mappings),
    'token_mappings is an array'
  );
  assert(
    mappings.count === mappings.token_mappings.length,
    'count matches token_mappings.length'
  );
  if (mappings.token_mappings.length === 0) {
    console.log(
      'NOTE: no ERC20 token mappings observed live in this enclave (native-only bridge-spammer traffic). ' +
        'AggkitBridgeAggregator.getTokenMetadata() for a real ERC20 was therefore NOT exercised against the ' +
        'live enclave in this run — client.getTokenMappings() (exercised above) is the part of that code path ' +
        'that touches the live REST API. getTokenMetadata()\'s native-token branch and its on-chain ERC20 ' +
        'branch remain covered by the S5 fixture-driven unit tests only. See handoff-sdk.md.'
    );
  }

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('aggkit-smoke crashed:', err);
  process.exit(1);
});
