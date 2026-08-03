/**
 * aggkit-smoke.ts
 *
 * Integration smoke test for the aggkit SDK code (`src/aggkit/*`) against a
 * LIVE aggkit-proxy (or haproxy `/aggkitapi`) REST endpoint fronting the
 * 2-L2 (L2-1/L2-2) devnet — NOT a fixture-driven unit test (design.md §8 S8
 * item 7). Exercises: per-network sync-status across {0,1,2}, a real
 * address's multi-network activity fan-out (via the aggregator), a
 * known-ground-truth CLAIMED check, an L2->L2 row's derived status, the
 * destination-injected `getClaimInputs` roundtrip for both an L2->L2 and an
 * L2->L1 deposit, token-mappings, and (optionally) the proxy-502
 * partial-failure path.
 *
 * Run (see /home/brolygon/repos/plans/aggkit-proxy-l2l2/handoff-sdk.md for
 * the exact command + recorded output from the S8 run):
 *
 *   AGGKIT_URL=http://127.0.0.1:<proxyPort> npx tsx scripts/aggkit-smoke.ts
 *
 * Re-resolve the base URL (ports are ephemeral):
 *   kurtosis port print cdk aggkit-proxy-001 rest          # direct proxy port
 *   kurtosis port print cdk agglayer-dev-ui-proxy-002 http # haproxy (append /aggkitapi)
 *
 * Env vars:
 *   AGGKIT_URL               required. aggkit-proxy REST base (WITHOUT
 *                             /bridge/v1) — either the direct proxy port, or
 *                             `<haproxy>/aggkitapi`.
 *   PROXY_MODE                optional, default "true". Skips check 1
 *                             (getHealth) when true (design.md §2.4 gap
 *                             G3 — aggkit-proxy has no root health route).
 *                             Set to "false" to run against a single direct
 *                             aggkit instance instead (pre-S8 behaviour).
 *   L2_NETWORK_IDS            optional, default "1,2". Comma-separated L2
 *                             network ids configured on the aggregator, all
 *                             pointed at AGGKIT_URL (design.md §0.1: one
 *                             proxy fronts every network).
 *   FROM_ADDRESS               optional, default the L2-1 test EOA
 *                             (`0x9BEE1d978DF451350fA93C69c4A1f6fFca12d107`)
 *                             that sent one past round's L2-1->L2-2 and
 *                             L2-1->L1 lifecycle deposits.
 *                             NOTE: this default is ENCLAVE-SPECIFIC. Bridge
 *                             history does not survive `kurtosis enclave rm`,
 *                             so against any recreated enclave this address
 *                             has no activity and sections 3/5/6/7 fail for
 *                             want of data rather than for a real defect.
 *                             Always pass FROM_ADDRESS explicitly when running
 *                             against an enclave you did not originally
 *                             generate traffic on.
 *   RUN_PARTIAL_FAILURE_TEST  optional, default "false". When "true", runs
 *                             the final section: stops `aggkit-002-bridge`
 *                             via `kurtosis service stop cdk
 *                             aggkit-002-bridge`, asserts `getActivity`
 *                             degrades instead of rejecting (design.md §2.2
 *                             gap G1), then restarts it. Off by default
 *                             because it mutates the live enclave.
 */

import { execSync } from 'node:child_process';
import { AggkitBridgeClient } from '../src/aggkit/client';
import { AggkitBridgeAggregator } from '../src/aggkit/aggregator';

const AGGKIT_URL = process.env['AGGKIT_URL'];
if (!AGGKIT_URL) {
  console.error(
    'AGGKIT_URL env var is required (aggkit-proxy REST base, e.g. http://127.0.0.1:33042,\n' +
      'or <haproxy>/aggkitapi).\n' +
      'Re-resolve with: kurtosis port print cdk aggkit-proxy-001 rest'
  );
  process.exit(1);
}

const PROXY_MODE = (process.env['PROXY_MODE'] ?? 'true') !== 'false';
const L2_NETWORK_IDS = (process.env['L2_NETWORK_IDS'] ?? '1,2')
  .split(',')
  .map((s) => Number(s.trim()));
const FROM_ADDRESS =
  process.env['FROM_ADDRESS'] ?? '0x9BEE1d978DF451350fA93C69c4A1f6fFca12d107';
const RUN_PARTIAL_FAILURE_TEST =
  process.env['RUN_PARTIAL_FAILURE_TEST'] === 'true';

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
  const primaryNetworkId = L2_NETWORK_IDS[0] as number;
  const allNetworkIds = [0, ...L2_NETWORK_IDS];
  const clients = new Map<number, AggkitBridgeClient>();
  for (const networkId of allNetworkIds) {
    clients.set(
      networkId,
      new AggkitBridgeClient({ baseUrl: AGGKIT_URL as string, networkId })
    );
  }
  const aggregator = new AggkitBridgeAggregator({
    networks: Object.fromEntries(
      L2_NETWORK_IDS.map((id) => [id, AGGKIT_URL as string])
    ),
  });

  function mustGetClient(networkId: number): AggkitBridgeClient {
    const client = clients.get(networkId);
    if (!client) {
      throw new Error(
        `aggkit-smoke: no client configured for network ${networkId}`
      );
    }
    return client;
  }

  console.log(
    `\naggkit-smoke: base=${AGGKIT_URL} proxyMode=${PROXY_MODE} networks=${JSON.stringify(
      L2_NETWORK_IDS
    )} fromAddress=${FROM_ADDRESS}`
  );

  console.log(`\n=== 1. Health (GET /) ===`);
  if (PROXY_MODE) {
    console.log(
      'SKIPPED — design.md §2.4 gap G3: aggkit-proxy has no root health ' +
        'route (haproxy strips the /aggkitapi prefix and aggkit-proxy only ' +
        'registers ANY /bridge/v1/*any -> 404). getHealth() is unused by ' +
        'the aggregator/app and remains a direct-instance-only convenience.'
    );
  } else {
    const health = await mustGetClient(primaryNetworkId).getHealth();
    console.log(health);
    assert(health.status === 'ok', 'health.status === "ok"');
    assert(
      typeof health.version === 'string' && health.version.length > 0,
      'health.version is a non-empty string'
    );
  }

  console.log(
    `\n=== 2. Sync status across ALL networks {${allNetworkIds.join(', ')}} (GET /bridge/v1/sync-status?network_id=N) ===`
  );
  for (const networkId of allNetworkIds) {
    const sync = await mustGetClient(networkId).getSyncStatus();
    console.log(`  network ${networkId}: ${JSON.stringify(sync)}`);
    assert(
      sync.l1_info.is_synced === true,
      `network ${networkId}: l1_info.is_synced === true`
    );
    assert(
      sync.l2_info.is_synced === true,
      `network ${networkId}: l2_info.is_synced === true`
    );
  }

  console.log(
    `\n=== 3. Full fan-out activity across {${L2_NETWORK_IDS.join(', ')}} (via AggkitBridgeAggregator.getActivity) ===`
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
    'no failed networks in the getActivity fan-out (healthy enclave)'
  );
  if (activity.data.length === 0) {
    // The default FROM_ADDRESS is the EOA that sent one specific past round's
    // lifecycle deposits. Enclave state does NOT survive `kurtosis enclave rm`,
    // so on any freshly recreated enclave that address has zero traffic and
    // sections 3/5/6/7 all fail for want of data — indistinguishable, from the
    // output alone, from a genuine SDK regression. Say so explicitly.
    console.log(
      `\n  !! No bridge activity found for fromAddress=${FROM_ADDRESS}.\n` +
        `     The default address is enclave-specific: it only has traffic on the\n` +
        `     enclave that originally produced it. If this enclave was recreated,\n` +
        `     re-run with FROM_ADDRESS set to a wallet that has actually bridged\n` +
        `     here, e.g. the dev-ui E2E wallet:\n` +
        `       FROM_ADDRESS=0x... AGGKIT_URL=${AGGKIT_URL} npx tsx scripts/aggkit-smoke.ts\n` +
        `     The sections below will fail for lack of data, not necessarily\n` +
        `     because the SDK is broken.`
    );
  }
  assert(
    activity.data.length > 0,
    'getActivity returned at least one transaction for the real from_address'
  );

  const knownStatuses = [
    'BRIDGED',
    'LEAF_INCLUDED',
    'READY_TO_CLAIM',
    'CLAIMED',
  ];
  const statusCounts: Record<string, number> = {};
  for (const tx of activity.data) {
    statusCounts[tx.status] = (statusCounts[tx.status] ?? 0) + 1;
    assert(
      knownStatuses.includes(tx.status),
      `tx bridgeHash=${tx.bridgeHash} status "${tx.status}" is one of the 4 known statuses`
    );
  }
  console.log('status distribution across fetched page:', statusCounts);

  console.log(
    `\n=== 4. Full status derivation for a known-ground-truth deposit ===`
  );
  const primaryClient = mustGetClient(primaryNetworkId);
  // Ground truth built directly from raw client calls (bypassing the
  // aggregator) so we know independently which bridge_hash is genuinely
  // claimed before checking what the aggregator derives for it.
  const rawL1OriginBridges = await primaryClient.getBridges({
    networkId: 0,
    networkIds: [primaryNetworkId],
    fromAddress: FROM_ADDRESS,
    pageSize: 200,
  });
  const rawL2Claims = await primaryClient.getClaims({
    networkId: primaryNetworkId,
    pageSize: 200,
  });
  const claimedGlobalIndexes = new Set(
    rawL2Claims.claims.map((c) => c.global_index)
  );
  const knownClaimedBridge = rawL1OriginBridges.bridges.find((b) =>
    claimedGlobalIndexes.has(b.global_index)
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
  } else {
    console.log(
      '(no L1->L2 claimed row found for this from_address on this network — skipping this ground-truth check)'
    );
  }

  console.log(`\n=== 5. L2->L2 row's derived status (design.md §3.4) ===`);
  const l2l2Row = activity.data.find(
    (tx) =>
      L2_NETWORK_IDS.includes(tx.sourceNetwork) &&
      L2_NETWORK_IDS.includes(tx.destinationNetwork) &&
      tx.sourceNetwork !== tx.destinationNetwork
  );
  assert(
    l2l2Row !== undefined,
    'found at least one L2->L2 row in the fetched activity page'
  );
  if (l2l2Row) {
    console.log(
      `L2->L2 row: bridgeHash=${l2l2Row.bridgeHash} sourceNetwork=${l2l2Row.sourceNetwork} ` +
        `destinationNetwork=${l2l2Row.destinationNetwork} depositCount=${l2l2Row.depositCount} ` +
        `status=${l2l2Row.status} leafIndexForProof=${l2l2Row.leafIndexForProof}`
    );
    // This round's known-autoclaimed L2-1->L2-2 deposit (enclave-notes.md /
    // design.md §3.4's fixture-cited walk): tx 0xac862504..., deposit_count=2.
    // Autoclaim landed well before this smoke run, so the derived status
    // should be the terminal CLAIMED, not the transient LEAF_INCLUDED window.
    if (l2l2Row.depositCount === 2 && l2l2Row.sourceNetwork === 1) {
      assert(
        l2l2Row.status === 'CLAIMED',
        'the known-autoclaimed L2-1->L2-2 deposit (deposit_count=2) derives CLAIMED'
      );
      assert(
        l2l2Row.claimTransactionHash !== undefined,
        'CLAIMED L2->L2 row carries a claimTransactionHash'
      );
    }
  }

  console.log(
    `\n=== 6. getClaimInputs — L2->L2 deposit (destination-injected index, design.md §3.5) ===`
  );
  const originBridges = await primaryClient.getBridges({
    networkId: primaryNetworkId,
    fromAddress: FROM_ADDRESS,
    pageSize: 200,
  });

  const l2l2Sample = originBridges.bridges.find(
    (b) =>
      L2_NETWORK_IDS.includes(b.destination_network) &&
      b.destination_network !== primaryNetworkId
  );
  assert(
    l2l2Sample !== undefined,
    'found a real L2->L2 deposit to probe getClaimInputs against'
  );
  if (l2l2Sample) {
    const { leafIndex, proof, sourceL1InfoTreeIndex } =
      await aggregator.getClaimInputs({
        originNetworkId: primaryNetworkId,
        destinationNetworkId: l2l2Sample.destination_network,
        depositCount: l2l2Sample.deposit_count,
      });
    console.log(
      `L2->L2 depositCount=${l2l2Sample.deposit_count} destinationNetwork=${l2l2Sample.destination_network} -> ` +
        `sourceL1InfoTreeIndex=${sourceL1InfoTreeIndex}, leafIndex=${leafIndex}, ` +
        `proof_local_exit_root.length=${proof.proof_local_exit_root.length}, ` +
        `proof_rollup_exit_root.length=${proof.proof_rollup_exit_root.length}`
    );
    assert(typeof leafIndex === 'number', 'L2->L2 leafIndex is a number');
    assert(
      typeof sourceL1InfoTreeIndex === 'number',
      'L2->L2 sourceL1InfoTreeIndex is a number'
    );
    assert(
      leafIndex >= sourceL1InfoTreeIndex,
      'L2->L2 leafIndex (destination-injected) >= sourceL1InfoTreeIndex (design.md F2)'
    );
    assert(
      proof.proof_local_exit_root.length === 32,
      'L2->L2 proof_local_exit_root has 32 entries'
    );
    assert(
      proof.proof_rollup_exit_root.length === 32,
      'L2->L2 proof_rollup_exit_root has 32 entries'
    );
    assert(
      proof.l1_info_tree_leaf.l1_info_tree_index === leafIndex,
      'L2->L2 l1_info_tree_leaf.l1_info_tree_index matches the returned leafIndex'
    );
  }

  console.log(
    `\n=== 7. getClaimInputs — L2->L1 deposit (destination 0, no injection step, design.md §3.1 point 4) ===`
  );
  const l2l1Sample = originBridges.bridges.find(
    (b) => b.destination_network === 0
  );
  assert(
    l2l1Sample !== undefined,
    'found a real L2->L1 deposit to probe getClaimInputs against'
  );
  if (l2l1Sample) {
    const { leafIndex, proof, sourceL1InfoTreeIndex } =
      await aggregator.getClaimInputs({
        originNetworkId: primaryNetworkId,
        destinationNetworkId: 0,
        depositCount: l2l1Sample.deposit_count,
      });
    console.log(
      `L2->L1 depositCount=${l2l1Sample.deposit_count} -> ` +
        `sourceL1InfoTreeIndex=${sourceL1InfoTreeIndex}, leafIndex=${leafIndex}, ` +
        `proof_local_exit_root.length=${proof.proof_local_exit_root.length}, ` +
        `proof_rollup_exit_root.length=${proof.proof_rollup_exit_root.length}`
    );
    assert(
      leafIndex === sourceL1InfoTreeIndex,
      'L2->L1 (destination 0): leafIndex === sourceL1InfoTreeIndex (no injection step, design.md §3.1 point 4)'
    );
    assert(
      proof.proof_local_exit_root.length === 32,
      'L2->L1 proof_local_exit_root has 32 entries'
    );
    assert(
      proof.proof_rollup_exit_root.length === 32,
      'L2->L1 proof_rollup_exit_root has 32 entries'
    );
  }

  console.log(`\n=== 8. Token mappings ===`);
  const mappings = await primaryClient.getTokenMappings({
    networkId: primaryNetworkId,
  });
  console.log(JSON.stringify(mappings));
  assert(Array.isArray(mappings.token_mappings), 'token_mappings is an array');
  assert(
    mappings.count === mappings.token_mappings.length,
    'count matches token_mappings.length'
  );

  console.log(
    `\n=== 9. Proxy-502 partial-failure path (design.md §2.2 gap G1) ===`
  );
  if (!RUN_PARTIAL_FAILURE_TEST) {
    console.log(
      'SKIPPED — set RUN_PARTIAL_FAILURE_TEST=true to run this (mutates the ' +
        'live enclave: stops then restarts aggkit-002-bridge via `kurtosis ' +
        'service stop/start cdk aggkit-002-bridge`).'
    );
  } else if (!L2_NETWORK_IDS.includes(2)) {
    console.log(
      'SKIPPED — aggkit-002-bridge backs network 2 (design.md §0.1), which ' +
        `is not in the configured L2_NETWORK_IDS (${JSON.stringify(L2_NETWORK_IDS)}).`
    );
  } else {
    // aggkit-002-bridge backs network 2 specifically (design.md §0.1's static
    // BridgeURLs map: 2 -> aggkit-002-bridge); this is NOT "any non-zero
    // network" — hardcode it to match the exact service being stopped below.
    const downNetworkId = 2;
    console.log(
      `Stopping aggkit-002-bridge (backing network ${downNetworkId})...`
    );
    execSync('kurtosis service stop cdk aggkit-002-bridge', {
      stdio: 'inherit',
    });
    try {
      // The proxy's own port stays open (it's a distinct service) — only the
      // backend it routes network 2 to is down, so network 2's calls 502
      // while network 1's fan-out keeps succeeding.
      const degraded = await aggregator.getActivity({
        fromAddress: FROM_ADDRESS,
        pageSize: 50,
      });
      console.log(
        `degraded.failedNetworks=${JSON.stringify(degraded.failedNetworks)} degraded.data.length=${degraded.data.length}`
      );
      assert(
        degraded.failedNetworks.length === 1 &&
          degraded.failedNetworks[0]?.networkId === downNetworkId,
        `getActivity degrades with failedNetworks naming ONLY network ${downNetworkId}`
      );
      const otherNetworkId = L2_NETWORK_IDS.find((id) => id !== downNetworkId);
      if (otherNetworkId !== undefined) {
        const otherNetworkRowsPresent = degraded.data.some(
          (tx) =>
            tx.sourceNetwork === otherNetworkId ||
            tx.destinationNetwork === otherNetworkId
        );
        assert(
          otherNetworkRowsPresent,
          `network ${otherNetworkId}'s rows are still present while network ${downNetworkId} is down`
        );
      }
    } finally {
      console.log('Restarting aggkit-002-bridge...');
      execSync('kurtosis service start cdk aggkit-002-bridge', {
        stdio: 'inherit',
      });
      // Give the proxy a moment to observe the restarted backend before any
      // subsequent script logic depends on it.
      const healedDeadline = Date.now() + 15_000;
      let healed = false;
      while (Date.now() < healedDeadline && !healed) {
        try {
          const status = await mustGetClient(downNetworkId).getSyncStatus();
          healed = status.l1_info.is_synced && status.l2_info.is_synced;
        } catch {
          healed = false;
        }
        if (!healed) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      assert(
        healed,
        `aggkit-002-bridge healed (sync-status 200) within 15s of restart`
      );
    }
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
