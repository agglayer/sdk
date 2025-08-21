/**
 * Base Contract Implementation
 *
 * Shared functionality for contract interactions
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Address,
  type Hex,
} from 'viem';
import { chainRegistry } from '../../chains/registry';

import type { BaseContractConfig } from '../../types';

export abstract class BaseContract {
  protected client: PublicClient;

  constructor(config: BaseContractConfig) {
    const chain = chainRegistry.getViemChain(config.chainId);
    this.client = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });
  }

  /**
   * Get nonce for an address
   */
  protected async getNonce(address?: string): Promise<string | undefined> {
    if (!address) return undefined;
    const nonceValue = await this.client.getTransactionCount({
      address: address as Address,
    });
    return `0x${nonceValue.toString(16)}`;
  }

  /**
   * Estimate gas for transaction
   */
  protected async estimateGas(
    data: Hex,
    to: string,
    from?: string
  ): Promise<string> {
    const gasEstimate = await this.client.estimateGas({
      account: from as Address,
      to: to as Address,
      data,
    });
    return gasEstimate.toString();
  }
}
