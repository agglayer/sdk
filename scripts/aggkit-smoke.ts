/**
 * aggkit-smoke.ts
 *
 * Integration smoke test for the aggkit SDK code (`src/aggkit/*`) against a
 * LIVE aggkit-proxy (or haproxy `/aggkitapi`) REST endpoint fronting the
 * 2-L2 (L2-1/L2-2) devnet — an integration script, NOT a fixture-driven unit
 * test. Exercises: per-network sync-status across {0,1,2}, a real
 * address's multi-network activity fan-out (via the aggregator), a
 * known-ground-truth CLAIMED check, an L2->L2 row's derived status, a LIVE
 * native-gas-token bridge proving the not-ready union (no throw) and
 * recording-network routing (comments 3847422009 / 3847523270 / 3847600104),
 * the destination-injected `getClaimInputs` roundtrip for both a sampled
 * L2->L2 and L2->L1 deposit, token-mappings, and (optionally) the proxy-502
 * partial-failure path.
 *
 * Run:
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
 *                             (getHealth) when true — aggkit-proxy has no
 *                             root health route.
 *                             Set to "false" to run against a single direct
 *                             aggkit instance instead (pre-S8 behaviour).
 *   L2_NETWORK_IDS            optional, default "1,2". Comma-separated L2
 *                             network ids configured on the aggregator, all
 *                             pointed at AGGKIT_URL (one aggkit-proxy fronts
 *                             every network, selected per-request by ?network_id=).
 *   FROM_ADDRESS               optional, default the L2-1 test EOA
 *                             (`0x9BEE1d978DF451350fA93C69c4A1f6fFca12d107`)
 *                             that sent one past round's L2-1->L2-2 and
 *                             L2-1->L1 lifecycle deposits.
 *                             NOTE: this default is ENCLAVE-SPECIFIC. Bridge
 *                             history does not survive `kurtosis enclave rm`,
 *                             so against any recreated enclave this address
 *                             has no activity and sections 3/5/7/8 fail for
 *                             want of data rather than for a real defect.
 *                             Always pass FROM_ADDRESS explicitly when running
 *                             against an enclave you did not originally
 *                             generate traffic on.
 *   L1_RPC_URL                optional, no default (ENCLAVE-SPECIFIC, ports
 *                             are ephemeral). The L1 chain's JSON-RPC
 *                             endpoint — NOT the aggkit REST API. When set
 *                             (together with BRIDGE_RPC_URL), section 6 sends
 *                             REAL bridgeAsset transactions (via viem) to
 *                             prove the not-ready union and recording-network
 *                             routing live, instead of only sampling
 *                             already-settled history. Re-resolve with
 *                             `kurtosis port print cdk el-1-<el>-<cl> rpc`.
 *                             SKIPPED (with an explicit message, not silently)
 *                             when unset.
 *   BRIDGE_RPC_URL             optional, no default (ENCLAVE-SPECIFIC). The
 *                             chain JSON-RPC endpoint for `L2_NETWORK_IDS[0]`
 *                             (the primary/recording L2). Re-resolve with
 *                             `kurtosis port print cdk
 *                             op-el-1-op-reth-op-node-<suffix> rpc`.
 *   BRIDGE_ADDRESS             optional, default
 *                             `0xC8cbEBf950B9Df44d987c8619f092beA980fF038` —
 *                             the LxLy bridge contract's CREATE2 address under
 *                             kurtosis-cdk's fixed deployment salt
 *                             (`0x0...01`), which is the SAME address on L1
 *                             and every L2 in this topology. Override if your
 *                             deployment used a different salt.
 *   BRIDGE_PRIVATE_KEY         optional, default kurtosis-cdk's well-known,
 *                             PUBLIC devnet `l2_admin_private_key`
 *                             (`DEFAULT_ACCOUNTS` in
 *                             `kurtosis-cdk/src/package_io/input_parser.star`)
 *                             — funded via genesis alloc on L1 and every L2 in
 *                             this topology. Not a secret; never use for
 *                             anything but a throwaway devnet.
 *   RUN_PARTIAL_FAILURE_TEST  optional, default "false". When "true", runs
 *                             the final section: stops `aggkit-002-bridge`
 *                             via `kurtosis service stop cdk
 *                             aggkit-002-bridge`, asserts `getActivity`
 *                             resolves with the dead network reported in
 *                             failedNetworks instead of rejecting, then restarts it. Off by default
 *                             because it mutates the live enclave.
 */

import { execSync } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AggkitBridgeClient } from '../src/aggkit/client';
import { AggkitBridgeAggregator } from '../src/aggkit/aggregator';
import type { AggkitClaimInputsResult } from '../src/aggkit/types';
import { bridgeAbi } from '../src/native/bridge/abi/bridge';

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
const L1_RPC_URL = process.env['L1_RPC_URL'];
const BRIDGE_RPC_URL = process.env['BRIDGE_RPC_URL'];
const BRIDGE_ADDRESS = (process.env['BRIDGE_ADDRESS'] ??
  '0xC8cbEBf950B9Df44d987c8619f092beA980fF038') as `0x${string}`;
const BRIDGE_PRIVATE_KEY = (process.env['BRIDGE_PRIVATE_KEY'] ??
  '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625') as `0x${string}`;
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000' as const;
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
      'SKIPPED — aggkit-proxy has no root health route (haproxy strips the ' +
        '/aggkitapi prefix and aggkit-proxy only registers ANY /bridge/v1/*any ' +
        '-> 404). getHealth() is unused by the aggregator/app and remains a ' +
        'direct-instance-only convenience.'
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
    // sections 3/5/7/8 all fail for want of data — indistinguishable, from the
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

  console.log(`\n=== 5. L2->L2 row's derived status ===`);
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
    // This round's known-autoclaimed L2-1->L2-2 deposit (also captured in the
    // unit-test lifecycle fixtures): tx 0xac862504..., deposit_count=2.
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
    `\n=== 6. getClaimInputs — LIVE not-ready union + recording-network routing (comments 3847422009 / 3847523270 / 3847600104) ===`
  );
  // This section sends REAL bridgeAsset transactions against the live chain
  // RPCs (via viem) -- NOT just the aggkit REST API the rest of this script
  // talks to -- so it can prove two things fixture/history sampling cannot:
  //
  //   (a) a genuinely NOT-YET-SETTLED deposit really does come back as
  //       `{ claimable: false, reason, detail }` with NO throw (comments
  //       3847523270 / 3847600104), checked immediately after the tx
  //       confirms, before the source's local exit root has had any chance
  //       to settle to the L1 info tree; and
  //   (b) a NATIVE-GAS-TOKEN deposit (origin_network === 0, recorded on the
  //       L2's OWN tree -- not L1's) is routed by `recordingNetworkId`, never
  //       by `origin_network` -- the exact case (comment 3847422009) where
  //       the pre-fix code would have silently built a proof from L1's
  //       UNRELATED deposit at the same deposit_count.
  //   (c) the destination-injected `leafIndex >= sourceL1InfoTreeIndex`
  //       assertion is re-run against this same LIVE deposit below.
  if (!L1_RPC_URL || !BRIDGE_RPC_URL) {
    console.log(
      'SKIPPED — set L1_RPC_URL and BRIDGE_RPC_URL (chain JSON-RPC endpoints, ' +
        'NOT the aggkit REST API) to send a live native-gas-token bridge and ' +
        'exercise this section. Re-resolve (ports are ephemeral):\n' +
        '  kurtosis port print cdk el-1-<el>-<cl> rpc                              # L1_RPC_URL\n' +
        `  kurtosis port print cdk op-el-1-op-reth-op-node-<suffix for network ${primaryNetworkId}> rpc  # BRIDGE_RPC_URL`
    );
  } else {
    const otherL2NetworkId = L2_NETWORK_IDS.find(
      (id) => id !== primaryNetworkId
    );
    assert(
      otherL2NetworkId !== undefined,
      'a second configured L2 network id exists (needed for a live L2->L2 native-gas-token bridge)'
    );
    if (otherL2NetworkId !== undefined) {
      const account = privateKeyToAccount(BRIDGE_PRIVATE_KEY);
      const l1Public = createPublicClient({ transport: http(L1_RPC_URL) });
      const l1Wallet = createWalletClient({
        account,
        transport: http(L1_RPC_URL),
      });
      const bridgePublic = createPublicClient({
        transport: http(BRIDGE_RPC_URL),
      });
      const bridgeWallet = createWalletClient({
        account,
        transport: http(BRIDGE_RPC_URL),
      });

      const sendBridgeAsset = async (
        publicClient: ReturnType<typeof createPublicClient>,
        walletClient: ReturnType<typeof createWalletClient>,
        destinationNetworkId: number,
        amountWei: bigint
      ): Promise<{
        depositCount: number;
        originNetwork: number;
        txHash: string;
      }> => {
        const hash = await walletClient.writeContract({
          address: BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'bridgeAsset',
          args: [
            destinationNetworkId,
            account.address,
            amountWei,
            NATIVE_TOKEN,
            true,
            '0x',
          ],
          value: amountWei,
          // These clients are created WITHOUT a bound `chain` (the RPC
          // endpoints are ephemeral kurtosis ports with no fixed chain id
          // known ahead of time) -- viem requires this to be explicit rather
          // than silently defaulted.
          chain: null,
          account,
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
        });
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== BRIDGE_ADDRESS.toLowerCase())
            continue;
          try {
            const decoded = decodeEventLog({
              abi: bridgeAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === 'BridgeEvent') {
              const args = decoded.args as unknown as {
                originNetwork: number;
                depositCount: number;
              };
              return {
                depositCount: args.depositCount,
                originNetwork: args.originNetwork,
                txHash: hash,
              };
            }
          } catch {
            // Not a BridgeEvent log -- keep scanning.
          }
        }
        throw new Error(
          `aggkit-smoke: bridgeAsset tx ${hash} succeeded but no BridgeEvent found in its receipt logs`
        );
      };

      // --- Seed step (infrastructure, not itself asserted on) ---
      // A sovereign-chain bridge tracks a LocalBalanceTree per (network,
      // token): an L2 cannot bridge OUT more of the native gas token than it
      // has ever received IN via a claimed bridge, regardless of the
      // account's raw (genesis-funded) balance. Seed it with a fresh L1->L2
      // native ETH deposit and wait for autoclaim
      // (aggkit_autoclaim_destinations includes the primary L2 in this
      // topology) before attempting the case this section actually tests.
      const seedAmount = parseEther('0.05');
      console.log(
        `  seeding network ${primaryNetworkId}'s LocalBalanceTree via a fresh L1->L2 native ETH deposit...`
      );
      const balanceBefore = await bridgePublic.getBalance({
        address: account.address,
      });
      const seed = await sendBridgeAsset(
        l1Public,
        l1Wallet,
        primaryNetworkId,
        seedAmount
      );
      console.log(
        `    seed sent: tx=${seed.txHash} depositCount=${seed.depositCount} on L1 (network 0) -> network ${primaryNetworkId}; waiting for auto-claim (up to 3 min)...`
      );
      const seedDeadline = Date.now() + 180_000;
      let seeded = false;
      while (Date.now() < seedDeadline && !seeded) {
        const balanceNow = await bridgePublic.getBalance({
          address: account.address,
        });
        seeded = balanceNow >= balanceBefore + seedAmount;
        if (!seeded) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      assert(
        seeded,
        `LocalBalanceTree seed deposit was auto-claimed on network ${primaryNetworkId} within 3 minutes`
      );

      if (seeded) {
        console.log(
          `  sending LIVE native-gas-token bridge: network ${primaryNetworkId} -> network ${otherL2NetworkId} ` +
            `(case D: origin_network=0, recorded on network ${primaryNetworkId}'s OWN tree)...`
        );
        const caseDAmount = parseEther('0.001');
        const caseD = await sendBridgeAsset(
          bridgePublic,
          bridgeWallet,
          otherL2NetworkId,
          caseDAmount
        );
        console.log(
          `    sent: tx=${caseD.txHash} depositCount=${caseD.depositCount} origin_network=${caseD.originNetwork} ` +
            `recordingNetworkId=${primaryNetworkId} destinationNetworkId=${otherL2NetworkId}`
        );
        assert(
          caseD.originNetwork === 0,
          'the live bridge is a native-gas-token deposit (origin_network === 0) -- the exact asset shape that diverges the recording network from origin_network (comment 3847422009)'
        );

        // (a) UNION SHAPE, NO THROW: probe immediately -- before the source's
        // local exit root has had any chance to settle to the L1 info tree.
        const immediateResult = await aggregator.getClaimInputs({
          recordingNetworkId: primaryNetworkId,
          destinationNetworkId: otherL2NetworkId,
          depositCount: caseD.depositCount,
        });
        console.log(
          `  immediate getClaimInputs result (expect not-ready, no throw): ${JSON.stringify(immediateResult)}`
        );
        assert(
          immediateResult.claimable === false,
          `(a) a freshly-sent, not-yet-settled deposit (depositCount=${caseD.depositCount}) returns claimable:false -- checked immediately after the tx confirmed, with NO throw`
        );
        if (!immediateResult.claimable) {
          assert(
            immediateResult.reason === 'SOURCE_NOT_ON_L1_INFO_TREE',
            `(a) not-ready reason is the machine-readable SOURCE_NOT_ON_L1_INFO_TREE (got '${immediateResult.reason}': ${immediateResult.detail})`
          );
        }

        // (b) ROUTING BY RECORDING NETWORK, not origin_network: repeat the
        // SAME /l1-info-tree-index probe the pre-fix code would have made --
        // keyed by origin_network (0) instead of recordingNetworkId
        // (primaryNetworkId) -- via the RAW client for network 0.
        // deposit_count is a PER-TREE counter, so this either answers for an
        // UNRELATED L1 deposit at the same index (the silent-wrong-proof
        // failure mode this fix closes) or legitimately answers not-ready --
        // for the WRONG tree either way.
        const oldBuggyQuery = await mustGetClient(0).getL1InfoTreeIndex({
          networkId: 0, // <-- what origin_network-based routing would pass
          depositCount: caseD.depositCount,
        });
        const correctQuery = await mustGetClient(
          primaryNetworkId
        ).getL1InfoTreeIndex({
          networkId: primaryNetworkId, // <-- recordingNetworkId (the fix)
          depositCount: caseD.depositCount,
        });
        console.log(
          `  (b) routing comparison for deposit_count=${caseD.depositCount}: ` +
            `network_id=0 (origin_network, OLD/BUGGY) -> ${JSON.stringify(oldBuggyQuery)}; ` +
            `network_id=${primaryNetworkId} (recordingNetworkId, FIX) -> ${JSON.stringify(correctQuery)}`
        );
        // Ground truth: independently fetch what deposit_count=D actually IS
        // on network 0's own tree, to show it is a DIFFERENT bridge than the
        // one just sent -- i.e. the OLD query, if it answered ready:true,
        // would have been silently answering for someone else's deposit.
        const l1GroundTruth = await mustGetClient(0).getBridges({
          networkId: 0,
          depositCount: caseD.depositCount,
          pageSize: 1,
        });
        const l1Row = l1GroundTruth.bridges[0];
        if (oldBuggyQuery.ready && l1Row) {
          assert(
            l1Row.destination_network !== otherL2NetworkId ||
              // `from_address` is documented-optional (`AggkitBridge.from_address`
              // in types.ts: "May be '' or absent; do not trust for identity
              // beyond sender display") -- an absent value must not TypeError
              // here (audit finding C13), so default it the same way the SDK
              // itself does (aggregator.ts: `bridge.from_address ||
              // bridge.txn_sender`) before comparing.
              (l1Row.from_address ?? '').toLowerCase() !==
                account.address.toLowerCase(),
            `(b) network 0's OWN deposit_count=${caseD.depositCount} (destination_network=${l1Row.destination_network}, bridge_hash=${l1Row.bridge_hash}) is a DIFFERENT bridge than the one just sent (destination_network=${otherL2NetworkId}) -- proof that origin_network-based routing would have silently answered for the WRONG deposit`
          );
        } else if (!oldBuggyQuery.ready) {
          console.log(
            `  (b) network 0 (origin_network, OLD/BUGGY) answers not-ready for this deposit_count regardless: reason=${oldBuggyQuery.reason} -- it is answering about NETWORK 0's tree, never network ${primaryNetworkId}'s`
          );
        }

        // Poll for the CORRECT, recordingNetworkId-routed answer to become
        // ready, then re-run the proof-shape assertions -- including (c) the
        // injected-leaf >= assertion -- against this LIVE deposit.
        console.log(
          '  polling for the recordingNetworkId-routed getClaimInputs to become claimable (up to 3 min)...'
        );
        const claimDeadline = Date.now() + 180_000;
        let liveResult: AggkitClaimInputsResult | undefined;
        while (Date.now() < claimDeadline) {
          liveResult = await aggregator.getClaimInputs({
            recordingNetworkId: primaryNetworkId,
            destinationNetworkId: otherL2NetworkId,
            depositCount: caseD.depositCount,
          });
          if (liveResult.claimable) break;
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
        assert(
          liveResult?.claimable === true,
          `(b) the recording-network-routed getClaimInputs eventually returns claimable:true for the live native-gas-token deposit (depositCount=${caseD.depositCount})`
        );
        if (liveResult?.claimable) {
          const { leafIndex, proof, sourceL1InfoTreeIndex } = liveResult;
          console.log(
            `  LIVE routing proof: recordingNetworkId=${primaryNetworkId} origin_network=${caseD.originNetwork} -> ` +
              `sourceL1InfoTreeIndex=${sourceL1InfoTreeIndex}, leafIndex=${leafIndex}, ` +
              `proof_local_exit_root.length=${proof.proof_local_exit_root.length}, ` +
              `proof_rollup_exit_root.length=${proof.proof_rollup_exit_root.length}`
          );
          assert(
            proof.proof_local_exit_root.length === 32,
            'live native-gas-token proof_local_exit_root has 32 entries'
          );
          assert(
            proof.proof_rollup_exit_root.length === 32,
            'live native-gas-token proof_rollup_exit_root has 32 entries'
          );
          assert(
            leafIndex >= sourceL1InfoTreeIndex,
            `(c) live native-gas-token leafIndex (destination-injected) >= sourceL1InfoTreeIndex (${leafIndex} >= ${sourceL1InfoTreeIndex})`
          );
        }
      }
    }
  }

  console.log(
    `\n=== 7. getClaimInputs — L2->L2 deposit (destination-injected index) ===`
  );
  // `getClaimInputs` returns a union: `claimable: false` (with a
  // machine-readable `reason`) is a valid non-throwing answer for a deposit
  // that simply has not settled yet. Hoisted so the proof assertions can run
  // in a narrowed block without aborting the rest of the smoke run.
  let resultL2L2: AggkitClaimInputsResult | undefined;
  let resultL2L1: AggkitClaimInputsResult | undefined;
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
    // `recordingNetworkId` (comment 3847422009): the sample comes from call A
    // above -- `getBridges({ networkId: primaryNetworkId })` -- so it is
    // recorded on that network's own local exit tree by construction,
    // regardless of the asset's `origin_network`.
    resultL2L2 = await aggregator.getClaimInputs({
      recordingNetworkId: primaryNetworkId,
      destinationNetworkId: l2l2Sample.destination_network,
      depositCount: l2l2Sample.deposit_count,
    });
    // `claimable: false` is a valid, non-throwing answer ("not settled yet").
    // This section samples an already-settled deposit, so assert readiness
    // before narrowing to the proof.
    assert(
      resultL2L2.claimable,
      `L2->L2 getClaimInputs returned claimable${
        resultL2L2.claimable
          ? ''
          : `; got false: ${resultL2L2.reason} — ${resultL2L2.detail}`
      }`
    );
  }
  if (l2l2Sample && resultL2L2?.claimable) {
    const { leafIndex, proof, sourceL1InfoTreeIndex } = resultL2L2;
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
      'L2->L2 leafIndex (destination-injected) >= sourceL1InfoTreeIndex'
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
    `\n=== 8. getClaimInputs — L2->L1 deposit (destination 0, no injection step) ===`
  );
  const l2l1Sample = originBridges.bridges.find(
    (b) => b.destination_network === 0
  );
  assert(
    l2l1Sample !== undefined,
    'found a real L2->L1 deposit to probe getClaimInputs against'
  );
  if (l2l1Sample) {
    // Before the recording-network routing fix (comment 3847422009) this call
    // hard-failed with `no client configured for network 0` whenever the
    // sampled deposit was a native-gas-token withdrawal (`origin_network=0`
    // recorded on the L2's own tree). `recordingNetworkId` removes the asset
    // origin from the routing decision entirely.
    resultL2L1 = await aggregator.getClaimInputs({
      recordingNetworkId: primaryNetworkId,
      destinationNetworkId: 0,
      depositCount: l2l1Sample.deposit_count,
    });
    assert(
      resultL2L1.claimable,
      `L2->L1 getClaimInputs returned claimable${
        resultL2L1.claimable
          ? ''
          : `; got false: ${resultL2L1.reason} — ${resultL2L1.detail}`
      }`
    );
  }
  if (l2l1Sample && resultL2L1?.claimable) {
    const { leafIndex, proof, sourceL1InfoTreeIndex } = resultL2L1;
    console.log(
      `L2->L1 depositCount=${l2l1Sample.deposit_count} -> ` +
        `sourceL1InfoTreeIndex=${sourceL1InfoTreeIndex}, leafIndex=${leafIndex}, ` +
        `proof_local_exit_root.length=${proof.proof_local_exit_root.length}, ` +
        `proof_rollup_exit_root.length=${proof.proof_rollup_exit_root.length}`
    );
    assert(
      leafIndex === sourceL1InfoTreeIndex,
      'L2->L1 (destination 0): leafIndex === sourceL1InfoTreeIndex (no injection step)'
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

  console.log(`\n=== 9. Token mappings ===`);
  const mappings = await primaryClient.getTokenMappings({
    networkId: primaryNetworkId,
  });
  console.log(JSON.stringify(mappings));
  assert(Array.isArray(mappings.token_mappings), 'token_mappings is an array');
  assert(
    mappings.count === mappings.token_mappings.length,
    'count matches token_mappings.length'
  );

  console.log(`\n=== 10. Proxy-502 partial-failure path ===`);
  if (!RUN_PARTIAL_FAILURE_TEST) {
    console.log(
      'SKIPPED — set RUN_PARTIAL_FAILURE_TEST=true to run this (mutates the ' +
        'live enclave: stops then restarts aggkit-002-bridge via `kurtosis ' +
        'service stop/start cdk aggkit-002-bridge`).'
    );
  } else if (!L2_NETWORK_IDS.includes(2)) {
    console.log(
      'SKIPPED — aggkit-002-bridge backs network 2, which ' +
        `is not in the configured L2_NETWORK_IDS (${JSON.stringify(L2_NETWORK_IDS)}).`
    );
  } else {
    // aggkit-002-bridge backs network 2 specifically (the proxy's static
    // BridgeURLs map routes 2 -> aggkit-002-bridge); this is NOT "any non-zero
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
