/**
 * Bridge Implementation
 *
 * Core bridge functionality for asset bridging between networks
 */

import { ValidationUtils } from '../utils';
import { BaseContract } from '../base/contract';
import type {
  BridgeAssetParams,
  BridgeConfig,
  TransactionParams,
  ClaimAssetParams,
  IsClaimedParams,
  WrappedTokenParams,
  BridgeMessageParams,
  ClaimMessageParams,
  PrecalculatedWrapperParams,
  OriginTokenInfoParams,
} from '../../types';
import {
  buildBridgeAsset as buildBridgeAssetTx,
  buildClaimAsset as buildClaimAssetTx,
} from './build';
import {
  buildBridgeMessage as buildBridgeMessageTx,
  buildClaimMessage as buildClaimMessageTx,
} from './message';
import { bridgeAbi } from './abi/bridge';
import { BridgeUtil } from './util';

export class Bridge extends BaseContract {
  private bridgeAddress: string;

  constructor(config: BridgeConfig) {
    super({ rpcUrl: config.rpcUrl, chainId: config.chainId });
    this.bridgeAddress = config.bridgeAddress;
  }

  /**
   * Build bridge asset transaction
   */
  async buildBridgeAsset(
    params: BridgeAssetParams,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(
      params.destinationAddress,
      'Destination address'
    );
    ValidationUtils.validateAddress(params.token, 'Token address');

    return buildBridgeAssetTx(
      {
        bridgeAddress: this.bridgeAddress,
        estimateGas: (data, to, from) => this.estimateGas(data, to, from),
        getNonce: (address) => this.getNonce(address),
      },
      params.destinationNetwork,
      params.destinationAddress as `0x${string}`,
      BigInt(params.amount),
      params.token as `0x${string}`,
      params.forceUpdateGlobalExitRoot,
      params.permitData,
      from
    );
  }

  /**
   * Build claim asset transaction
   */
  async buildClaimAsset(
    params: ClaimAssetParams,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(
      params.originTokenAddress,
      'Origin token address'
    );
    ValidationUtils.validateAddress(
      params.destinationAddress,
      'Destination address'
    );

    return buildClaimAssetTx(
      {
        bridgeAddress: this.bridgeAddress,
        estimateGas: (data, to, from) => this.estimateGas(data, to, from),
        getNonce: (address) => this.getNonce(address),
      },
      params.smtProofLocalExitRoot,
      params.smtProofRollupExitRoot,
      params.globalIndex,
      params.mainnetExitRoot,
      params.rollupExitRoot,
      params.originNetwork,
      params.originTokenAddress as `0x${string}`,
      params.destinationNetwork,
      params.destinationAddress as `0x${string}`,
      params.amount,
      params.metadata,
      from
    );
  }

  /**
   * Check if bridge deposit is claimed
   */
  async isClaimed(params: IsClaimedParams): Promise<boolean> {
    const result = await this.client.readContract({
      address: this.bridgeAddress as `0x${string}`,
      abi: bridgeAbi,
      functionName: 'isClaimed',
      args: [params.leafIndex, params.sourceBridgeNetwork],
    });
    return result;
  }

  /**
   * Get wrapped token address
   */
  async getWrappedTokenAddress(params: WrappedTokenParams): Promise<string> {
    ValidationUtils.validateAddress(
      params.originTokenAddress,
      'Origin token address'
    );

    const result = await this.client.readContract({
      address: this.bridgeAddress as `0x${string}`,
      abi: bridgeAbi,
      functionName: 'getTokenWrappedAddress',
      args: [params.originNetwork, params.originTokenAddress as `0x${string}`],
    });
    return result;
  }

  /**
   * Get network ID
   */
  async getNetworkId(): Promise<number> {
    const result = await this.client.readContract({
      address: this.bridgeAddress as `0x${string}`,
      abi: bridgeAbi,
      functionName: 'networkID',
      args: [],
    });
    return Number(result);
  }

  /**
   * Get bridge contract address
   */
  getBridgeAddress(): string {
    return this.bridgeAddress;
  }

  /**
   * Build bridge message transaction
   */
  async buildBridgeMessage(
    params: BridgeMessageParams,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(
      params.destinationAddress,
      'Destination address'
    );

    return buildBridgeMessageTx(
      {
        bridgeAddress: this.bridgeAddress,
        estimateGas: (data, to, from) => this.estimateGas(data, to, from),
        getNonce: (address) => this.getNonce(address),
      },
      params.destinationNetwork,
      params.destinationAddress as `0x${string}`,
      params.forceUpdateGlobalExitRoot,
      params.permitData || '0x',
      from
    );
  }

  /**
   * Build claim message transaction
   */
  async buildClaimMessage(
    params: ClaimMessageParams,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(
      params.originTokenAddress,
      'Origin token address'
    );
    ValidationUtils.validateAddress(
      params.destinationAddress,
      'Destination address'
    );

    return buildClaimMessageTx(
      {
        bridgeAddress: this.bridgeAddress,
        estimateGas: (data, to, from) => this.estimateGas(data, to, from),
        getNonce: (address) => this.getNonce(address),
      },
      params.smtProofLocalExitRoot,
      params.smtProofRollupExitRoot,
      params.globalIndex,
      params.mainnetExitRoot,
      params.rollupExitRoot,
      params.originNetwork,
      params.originTokenAddress as `0x${string}`,
      params.destinationNetwork,
      params.destinationAddress as `0x${string}`,
      params.amount,
      params.metadata,
      from
    );
  }

  /**
   * Get precalculated wrapper address
   */
  async getPrecalculatedWrapperAddress(
    params: PrecalculatedWrapperParams
  ): Promise<string> {
    ValidationUtils.validateAddress(
      params.originTokenAddress,
      'Origin token address'
    );

    const result = await this.client.readContract({
      address: this.bridgeAddress as `0x${string}`,
      abi: bridgeAbi,
      functionName: 'precalculatedWrapperAddress',
      args: [params.originNetwork, params.originTokenAddress as `0x${string}`],
    });
    return result;
  }

  /**
   * Get origin token info from wrapped token
   */
  async getOriginTokenInfo(
    params: OriginTokenInfoParams
  ): Promise<readonly [number, string]> {
    ValidationUtils.validateAddress(
      params.wrappedToken,
      'Wrapped token address'
    );

    const result = await this.client.readContract({
      address: this.bridgeAddress as `0x${string}`,
      abi: bridgeAbi,
      functionName: 'wrappedTokenToTokenInfo',
      args: [params.wrappedToken as `0x${string}`],
    });
    return result;
  }

  /**
   * Build claim asset transaction from bridge transaction hash
   *
   * @param transactionHash - Hash of the bridge transaction on the source network
   * @param sourceNetworkId - Network ID of the source network (where bridge tx happened)
   * @param bridgeIndex - Index of bridge event in transaction (default: 0)
   * @param from - From address for the claim transaction
   */
  async buildClaimAssetFromHash(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0,
    from?: string
  ): Promise<TransactionParams> {
    const bridgeUtil = await BridgeUtil.fromNetworkId(sourceNetworkId);
    const params = await bridgeUtil.buildClaimAssetParams(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );

    return this.buildClaimAsset(params, from);
  }

  /**
   * Build claim message transaction from bridge transaction hash
   *
   * @param transactionHash - Hash of the bridge transaction on the source network
   * @param sourceNetworkId - Network ID of the source network (where bridge tx happened)
   * @param bridgeIndex - Index of bridge event in transaction (default: 0)
   * @param from - From address for the claim transaction
   */
  async buildClaimMessageFromHash(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0,
    from?: string
  ): Promise<TransactionParams> {
    const bridgeUtil = await BridgeUtil.fromNetworkId(sourceNetworkId);
    const params = await bridgeUtil.buildClaimMessageParams(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );

    return this.buildClaimMessage(params, from);
  }

  /**
   * Get bridge event info from transaction hash
   *
   * @param transactionHash - Hash of the bridge transaction on the source network
   * @param sourceNetworkId - Network ID of the source network (where bridge tx happened)
   * @param bridgeIndex - Index of bridge event in transaction (default: 0)
   */
  async getBridgeEventInfo(
    transactionHash: string,
    sourceNetworkId: number,
    bridgeIndex = 0
  ) {
    const bridgeUtil = await BridgeUtil.fromNetworkId(sourceNetworkId);
    return bridgeUtil.getBridgeEventInfo(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );
  }
}
