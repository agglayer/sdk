/**
 * Bridge Utility Implementation
 *
 * User-friendly bridge operations that abstract complex parameter handling
 */

import {
  type PublicClient,
  decodeEventLog,
  createPublicClient,
  http,
} from 'viem';
import type { ClaimAssetParams, ClaimMessageParams } from '../../types';
import { bridgeAbi } from './abi/bridge';
import { chainRegistry } from '../../chains/registry';

export interface BridgeEventInfo {
  originNetwork: number;
  originTokenAddress: string;
  destinationNetwork: number;
  destinationAddress: string;
  amount: bigint;
  metadata: string;
  depositCount: number;
}

export interface MerkleProof {
  merkle_proof: string[];
  rollup_merkle_proof?: string[];
  exit_root_num?: string; // Match lxly.js interface
  l2_exit_root_num?: string; // Match lxly.js interface
  main_exit_root: string;
  rollup_exit_root: string;
}

export interface ClaimPayload {
  smtProof: string[];
  smtProofRollup: string[] | undefined;
  globalIndex: string;
  mainnetExitRoot: string;
  rollupExitRoot: string;
  originNetwork: number;
  originTokenAddress: string;
  destinationNetwork: number;
  destinationAddress: string;
  amount: bigint;
  metadata: string;
}

export class BridgeUtil {
  private client: PublicClient;
  private proofApiUrl: string;
  private BRIDGE_TOPIC =
    '0x501781209a1f8899323b96b4ef08b168df93e0a90c673d1e4cce39366cb62f9b';

  constructor(client: PublicClient, proofApiUrl: string) {
    this.client = client;
    this.proofApiUrl = proofApiUrl;
  }

  /**
   * Create BridgeUtil instance from network ID using chain registry
   *
   * @param sourceNetworkId - Network ID of the source network
   * @returns BridgeUtil instance configured for the source network
   */
  static async fromNetworkId(sourceNetworkId: number): Promise<BridgeUtil> {
    const chain = BridgeUtil.findChain(sourceNetworkId);

    if (!chain.proofApiUrl) {
      throw new Error(
        `No proof API URL configured for network ${sourceNetworkId}`
      );
    }

    const sourceClient = createPublicClient({
      transport: http(chain.rpcUrl),
    });

    return new BridgeUtil(sourceClient, chain.proofApiUrl);
  }

  /**
   * Find chain configuration by network ID
   *
   * @param sourceNetworkId - Network ID to search for
   * @returns Chain configuration
   * @throws Error if chain not found
   */
  private static findChain(sourceNetworkId: number) {
    try {
      return chainRegistry.getChainByNetworkId(sourceNetworkId);
    } catch {
      // Generate helpful error message with available options
      const allChains = chainRegistry.getAllChains();
      const availableNetworkIds = allChains
        .map((chain) => chain.networkId)
        .filter(Boolean)
        .join(', ');

      throw new Error(
        `Source network ${sourceNetworkId} not found in chain registry. ` +
          `Available network IDs: ${availableNetworkIds}`
      );
    }
  }

  /**
   * Extract bridge event data from transaction receipt
   */
  private async extractBridgeEvent(
    transactionHash: string,
    _networkId: number,
    bridgeIndex = 0
  ): Promise<BridgeEventInfo> {
    try {
      const receipt = await this.client.getTransactionReceipt({
        hash: transactionHash as `0x${string}`,
      });

      const bridgeLogs = receipt.logs.filter(
        (log) =>
          log.topics[0] &&
          log.topics[0].toLowerCase() === this.BRIDGE_TOPIC.toLowerCase()
      );

      if (!bridgeLogs.length) {
        throw new Error('No bridge event found in transaction receipt');
      }

      if (bridgeIndex >= bridgeLogs.length) {
        throw new Error(
          `Bridge index ${bridgeIndex} not found. Available indices: 0-${bridgeLogs.length - 1}`
        );
      }

      const log = bridgeLogs[bridgeIndex];

      if (!log) {
        throw new Error('Bridge log not found');
      }

      const decoded = decodeEventLog({
        abi: bridgeAbi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== 'BridgeEvent') {
        throw new Error('Invalid bridge event');
      }

      const args = decoded.args as {
        originNetwork: number;
        originAddress: string;
        destinationNetwork: number;
        destinationAddress: string;
        amount: bigint;
        metadata: string;
        depositCount: number;
      };

      const {
        originNetwork,
        originAddress,
        destinationNetwork,
        destinationAddress,
        amount,
        metadata,
        depositCount,
      } = args;

      return {
        originNetwork: Number(originNetwork),
        originTokenAddress: originAddress as string,
        destinationNetwork: Number(destinationNetwork),
        destinationAddress: destinationAddress as string,
        amount: amount as bigint,
        metadata: (metadata as string) || '0x',
        depositCount: Number(depositCount),
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to extract bridge event: ${error.message}`);
      }
      throw new Error('Failed to extract bridge event: Unknown error');
    }
  }

  /**
   * Fetch merkle proof from Polygon's proof API
   */
  private async fetchMerkleProof(
    networkId: number,
    depositCount: number
  ): Promise<MerkleProof> {
    try {
      const baseUrl = this.proofApiUrl.endsWith('/')
        ? this.proofApiUrl
        : `${this.proofApiUrl}/`;
      const url = `${baseUrl}merkle-proof?networkId=${networkId}&depositCount=${depositCount}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch merkle proof: ${response.statusText} (${response.status})`
        );
      }

      const data = (await response.json()) as { proof: MerkleProof };

      if (!data.proof) {
        throw new Error('Invalid response format: missing proof data');
      }

      return data.proof;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch merkle proof: ${error.message}`);
      }
      throw new Error('Failed to fetch merkle proof: Unknown error');
    }
  }

  /**
   * Compute global index from local index and network ID
   */
  private computeGlobalIndex(
    indexLocal: number,
    sourceNetworkId: number
  ): bigint {
    const MAINNET_FLAG = BigInt(2 ** 64); // Match lxly.js implementation

    if (BigInt(sourceNetworkId) === BigInt(0)) {
      return BigInt(indexLocal) + MAINNET_FLAG;
    } else {
      return BigInt(indexLocal) + BigInt(sourceNetworkId - 1) * BigInt(2 ** 32);
    }
  }

  /**
   * Build claim payload from transaction hash (user-friendly method)
   */
  async buildPayloadForClaim(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0
  ): Promise<ClaimPayload> {
    // Extract bridge event data
    const bridgeEvent = await this.extractBridgeEvent(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );

    // Fetch merkle proof
    const proof = await this.fetchMerkleProof(
      sourceNetworkId,
      bridgeEvent.depositCount
    );

    // Compute global index
    const globalIndex = this.computeGlobalIndex(
      bridgeEvent.depositCount,
      sourceNetworkId
    );

    return {
      smtProof: proof.merkle_proof,
      smtProofRollup: proof.rollup_merkle_proof,
      globalIndex: globalIndex.toString(),
      mainnetExitRoot: proof.main_exit_root,
      rollupExitRoot: proof.rollup_exit_root,
      originNetwork: bridgeEvent.originNetwork,
      originTokenAddress: bridgeEvent.originTokenAddress,
      destinationNetwork: bridgeEvent.destinationNetwork,
      destinationAddress: bridgeEvent.destinationAddress,
      amount: bridgeEvent.amount,
      metadata: bridgeEvent.metadata,
    };
  }

  /**
   * Build claim asset parameters from transaction hash
   */
  async buildClaimAssetParams(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0
  ): Promise<ClaimAssetParams> {
    const payload = await this.buildPayloadForClaim(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );

    return {
      smtProofLocalExitRoot: payload.smtProof as readonly `0x${string}`[],
      smtProofRollupExitRoot:
        payload.smtProofRollup as readonly `0x${string}`[],
      globalIndex: BigInt(payload.globalIndex),
      mainnetExitRoot: payload.mainnetExitRoot as `0x${string}`,
      rollupExitRoot: payload.rollupExitRoot as `0x${string}`,
      originNetwork: payload.originNetwork,
      originTokenAddress: payload.originTokenAddress,
      destinationNetwork: payload.destinationNetwork,
      destinationAddress: payload.destinationAddress,
      amount: payload.amount,
      metadata: payload.metadata as `0x${string}`,
    };
  }

  /**
   * Build claim message parameters from transaction hash
   */
  async buildClaimMessageParams(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0
  ): Promise<ClaimMessageParams> {
    const payload = await this.buildPayloadForClaim(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );

    return {
      smtProofLocalExitRoot: payload.smtProof as readonly `0x${string}`[],
      smtProofRollupExitRoot:
        payload.smtProofRollup as readonly `0x${string}`[],
      globalIndex: BigInt(payload.globalIndex),
      mainnetExitRoot: payload.mainnetExitRoot as `0x${string}`,
      rollupExitRoot: payload.rollupExitRoot as `0x${string}`,
      originNetwork: payload.originNetwork,
      originTokenAddress: payload.originTokenAddress,
      destinationNetwork: payload.destinationNetwork,
      destinationAddress: payload.destinationAddress,
      amount: payload.amount,
      metadata: payload.metadata as `0x${string}`,
    };
  }

  /**
   * Get bridge event info from transaction hash
   */
  async getBridgeEventInfo(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0
  ): Promise<BridgeEventInfo> {
    return this.extractBridgeEvent(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );
  }
}
