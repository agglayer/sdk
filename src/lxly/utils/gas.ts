/**
 * Gas Utilities
 *
 * Simple gas estimation with EIP-1559 support and fallback
 */

import { type PublicClient, type Address, type Hex } from 'viem';

export interface GasEstimate {
  gasLimit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  estimatedCost: bigint;
}

export interface FeeData {
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  lastBaseFeePerGas?: bigint;
}

export class GasEstimator {
  /**
   * Estimate gas with EIP-1559 support and fallback
   */
  static async estimateGas(
    client: PublicClient,
    data: Hex,
    to: Address,
    from?: Address
  ): Promise<GasEstimate> {
    try {
      // Try EIP-1559 first
      const [gasLimit, feeData] = await Promise.all([
        client.estimateGas({
          account: from,
          to,
          data,
        }),
        client.estimateFeesPerGas(),
      ]);

      return {
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        estimatedCost: gasLimit * (feeData.maxFeePerGas || 0n),
      };
    } catch {
      // Fallback to legacy gas estimation
      const gasLimit = await client.estimateGas({
        account: from,
        to,
        data,
      });

      const gasPrice = await client.getGasPrice();

      return {
        gasLimit,
        gasPrice,
        estimatedCost: gasLimit * gasPrice,
      };
    }
  }

  /**
   * Get current network fee data
   */
  static async getNetworkFeeData(client: PublicClient): Promise<FeeData> {
    try {
      const feeData = await client.estimateFeesPerGas();
      return {
        gasPrice: await client.getGasPrice(),
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };
    } catch {
      const gasPrice = await client.getGasPrice();
      return {
        gasPrice,
      };
    }
  }

  /**
   * Get nonce for an address
   */
  static async getNonce(
    client: PublicClient,
    address?: Address
  ): Promise<string | undefined> {
    if (!address) return undefined;
    const nonceValue = await client.getTransactionCount({ address });
    return nonceValue.toString();
  }
}
