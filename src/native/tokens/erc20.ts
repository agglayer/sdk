/**
 * ERC20 Token Implementation
 *
 * Core ERC20 functionality for balance, allowance, and transaction building
 */

import { type Address } from 'viem';

import { ValidationUtils } from '../utils';
import { BaseContract } from '../base/contract';
import type { ERC20Config, TransactionParams, BridgeOptions } from '@/types';
import {
  buildApprove as buildApproveTx,
  buildTransfer as buildTransferTx,
  buildTransferFrom as buildTransferFromTx,
} from './build';
import { Bridge } from '../bridge/bridge';
import { chainRegistry } from '../chains/registry';
import { getAbi } from '../services/abi';

export type { ERC20Config, TransactionParams };

export class ERC20 extends BaseContract {
  private tokenAddress: string;
  private config: ERC20Config;

  constructor(config: ERC20Config) {
    super({ rpcUrl: config.rpcUrl, chainId: config.chainId });
    this.tokenAddress = config.tokenAddress;
    this.config = config;
  }

  /**
   * Get ERC20 token balance in wei
   */
  async getBalance(address: string): Promise<string> {
    ValidationUtils.validateAddress(address, 'Address');

    const balance = await this.client.readContract({
      address: this.tokenAddress as Address,
      abi: getAbi('ERC20'),
      functionName: 'balanceOf',
      args: [address as Address],
    });
    return balance.toString();
  }

  /**
   * Get allowance in wei
   */
  async getAllowance(owner: string, spender: string): Promise<string> {
    ValidationUtils.validateAddress(owner, 'Owner address');
    ValidationUtils.validateAddress(spender, 'Spender address');

    try {
      const allowance = await this.client.readContract({
        address: this.tokenAddress as Address,
        abi: getAbi('ERC20'),
        functionName: 'allowance',
        args: [owner as Address, spender as Address],
      });
      return allowance.toString();
    } catch (error) {
      throw new Error(
        `Failed to get allowance: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Build approve transaction
   */
  async buildApprove(
    spender: string,
    amount: string,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(spender, 'Spender address');
    ValidationUtils.validateAmount(amount, 'Amount');

    return buildApproveTx(
      {
        tokenAddress: this.tokenAddress,
        estimateGas: (data, from) =>
          this.estimateGas(data, this.tokenAddress, from),
        getNonce: (address) => this.getNonce(address),
      },
      spender as Address,
      BigInt(amount),
      from
    );
  }

  /**
   * Build transfer transaction
   */
  async buildTransfer(
    to: string,
    amount: string,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(to, 'Recipient address');
    ValidationUtils.validateAmount(amount, 'Amount');

    return buildTransferTx(
      {
        tokenAddress: this.tokenAddress,
        estimateGas: (data, from) =>
          this.estimateGas(data, this.tokenAddress, from),
        getNonce: (address) => this.getNonce(address),
      },
      to as Address,
      BigInt(amount),
      from
    );
  }

  /**
   * Build transferFrom transaction
   */
  async buildTransferFrom(
    from: string,
    to: string,
    amount: string,
    spender?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(from, 'Owner address');
    ValidationUtils.validateAddress(to, 'Recipient address');
    ValidationUtils.validateAmount(amount, 'Amount');

    return buildTransferFromTx(
      {
        tokenAddress: this.tokenAddress,
        estimateGas: (data, from) =>
          this.estimateGas(data, this.tokenAddress, from),
        getNonce: (address) => this.getNonce(address),
      },
      from as Address,
      to as Address,
      BigInt(amount),
      spender
    );
  }

  /**
   * Bridge this token to another network
   */
  async bridgeTo(
    destinationNetwork: number,
    destinationAddress: string,
    amount: string,
    from?: string,
    options: BridgeOptions = {}
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(destinationAddress, 'Destination address');
    ValidationUtils.validateAmount(amount, 'Amount');

    const bridge = this.getBridge();

    return bridge.buildBridgeAsset(
      {
        destinationNetwork,
        destinationAddress,
        amount,
        token: this.tokenAddress,
        forceUpdateGlobalExitRoot: options.forceUpdateGlobalExitRoot ?? true,
        permitData: options.permitData || '0x',
      },
      from
    );
  }

  /**
   * Get wrapped version of this token on destination network
   */
  async getWrappedToken(): Promise<string> {
    const bridge = this.getBridge();
    return bridge.getWrappedTokenAddress({
      originNetwork: this.config.chainId,
      originTokenAddress: this.tokenAddress,
    });
  }

  /**
   * Claim asset from bridge transaction hash
   *
   * @param transactionHash - Hash of the bridge transaction on the source network
   * @param sourceNetworkId - Network ID of the source network (where bridge tx happened)
   * @param leafIndex - Leaf index for the claim proof
   * @param bridgeIndex - Index of bridge event in transaction (default: 0)
   * @param from - From address for the claim transaction
   */
  async claimAsset(
    transactionHash: string,
    sourceNetworkId: number,
    leafIndex: number,
    bridgeIndex = 0,
    from?: string
  ): Promise<TransactionParams> {
    const bridge = this.getBridge();
    return bridge.buildClaimAssetFromHash(
      transactionHash,
      sourceNetworkId,
      leafIndex,
      bridgeIndex,
      from
    );
  }

  /**
   * Claim message from bridge transaction hash
   *
   * @param transactionHash - Hash of the bridge transaction on the source network
   * @param sourceNetworkId - Network ID of the source network (where bridge tx happened)
   * @param leafIndex - Leaf index for the claim proof
   * @param bridgeIndex - Index of bridge event in transaction (default: 0)
   * @param from - From address for the claim transaction
   */
  async claimMessage(
    transactionHash: string,
    sourceNetworkId: number,
    leafIndex: number,
    bridgeIndex = 0,
    from?: string
  ): Promise<TransactionParams> {
    const bridge = this.getBridge();
    return bridge.buildClaimMessageFromHash(
      transactionHash,
      sourceNetworkId,
      leafIndex,
      bridgeIndex,
      from
    );
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
    const bridge = this.getBridge();
    return bridge.getBridgeEventInfo(
      transactionHash,
      sourceNetworkId,
      bridgeIndex
    );
  }

  private getBridge(): Bridge {
    const chain = chainRegistry.getChain(this.config.chainId);
    if (!chain.bridgeAddress) {
      throw new Error(
        `No bridge address configured for network ${this.config.chainId}`
      );
    }

    return new Bridge({
      bridgeAddress: chain.bridgeAddress,
      rpcUrl: this.config.rpcUrl,
      chainId: this.config.chainId,
    });
  }
}
