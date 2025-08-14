/**
 * ERC20 Token Implementation
 *
 * Core ERC20 functionality for balance, allowance, and transaction building
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Address,
  type Hex,
} from 'viem';
import { chainRegistry } from '../../chains/registry';
import { erc20Abi } from './abi/erc20';
import { ValidationUtils } from '../utils';
import type { ERC20Config, TransactionParams } from './types';
import {
  buildApprove as buildApproveTx,
  buildTransfer as buildTransferTx,
  buildTransferFrom as buildTransferFromTx,
} from './build';

export type { ERC20Config, TransactionParams };

export class ERC20 {
  private config: ERC20Config;
  private client: PublicClient;

  constructor(config: ERC20Config) {
    this.config = config;

    // Get chain from registry
    const chain = chainRegistry.getViemChain(config.chainId);

    this.client = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });
  }

  /**
   * Get ERC20 token balance in wei
   */
  async getBalance(address: string): Promise<string> {
    ValidationUtils.validateAddress(address, 'Address');

    const balance = await this.client.readContract({
      address: this.config.tokenAddress as Address,
      abi: erc20Abi,
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
        address: this.config.tokenAddress as Address,
        abi: erc20Abi,
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
   * Get nonce for an address
   */
  private async getNonce(address?: string): Promise<string | undefined> {
    if (!address) return undefined;
    const nonceValue = await this.client.getTransactionCount({
      address: address as Address,
    });
    return nonceValue.toString();
  }

  /**
   * Estimate gas for transaction
   */
  private async estimateGas(data: Hex, from?: string): Promise<string> {
    const gasEstimate = await this.client.estimateGas({
      account: from as Address,
      to: this.config.tokenAddress as Address,
      data,
    });
    return gasEstimate.toString();
  }

  /**
   * Convert amount to BigInt
   */
  private toBigInt(amount: string | number | bigint): bigint {
    return BigInt(amount.toString());
  }

  /**
   * Build approve transaction
   */
  async buildApprove(
    spender: string,
    amount: string | number | bigint,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(spender, 'Spender address');
    ValidationUtils.validateAmount(amount, 'Amount');

    return buildApproveTx(
      {
        tokenAddress: this.config.tokenAddress,
        estimateGas: (data, f) => this.estimateGas(data, f),
        getNonce: (addr) => this.getNonce(addr),
      },
      spender as Address,
      this.toBigInt(amount),
      from
    );
  }

  /**
   * Build transfer transaction
   */
  async buildTransfer(
    to: string,
    amount: string | number | bigint,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(to, 'Recipient address');
    ValidationUtils.validateAmount(amount, 'Amount');

    return buildTransferTx(
      {
        tokenAddress: this.config.tokenAddress,
        estimateGas: (data, f) => this.estimateGas(data, f),
        getNonce: (addr) => this.getNonce(addr),
      },
      to as Address,
      this.toBigInt(amount),
      from
    );
  }

  /**
   * Build transferFrom transaction
   */
  async buildTransferFrom(
    from: string,
    to: string,
    amount: string | number | bigint,
    spender?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(from, 'Owner address');
    ValidationUtils.validateAddress(to, 'Recipient address');
    ValidationUtils.validateAmount(amount, 'Amount');

    return buildTransferFromTx(
      {
        tokenAddress: this.config.tokenAddress,
        estimateGas: (data, f) => this.estimateGas(data, f),
        getNonce: (addr) => this.getNonce(addr),
      },
      from as Address,
      to as Address,
      this.toBigInt(amount),
      spender
    );
  }
}
