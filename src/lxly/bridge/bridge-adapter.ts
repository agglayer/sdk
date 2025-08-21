/**
 * Bridge Adapter Implementation
 *
 * Custom ERC20 bridging functionality using bridge adapter contract
 */

import { encodeFunctionData, type Address } from 'viem';
import { ValidationUtils } from '../utils';
import { BaseContract } from '../base/contract';
import type { BridgeTokenParams, TransactionParams } from '../../types';
import { bridgeAdapterAbi } from './abi/bridge-adapter';

export interface BridgeAdapterConfig {
  bridgeAdapterAddress: string;
  rpcUrl: string;
  chainId: number;
}

export class BridgeAdapter extends BaseContract {
  private bridgeAdapterAddress: string;

  constructor(config: BridgeAdapterConfig) {
    super({ rpcUrl: config.rpcUrl, chainId: config.chainId });
    this.bridgeAdapterAddress = config.bridgeAdapterAddress;
  }

  /**
   * Build bridge token transaction for custom ERC20
   */
  async buildBridgeToken(
    params: BridgeTokenParams,
    from?: string
  ): Promise<TransactionParams> {
    ValidationUtils.validateAddress(params.recipient, 'Recipient address');
    ValidationUtils.validateAmount(params.amount, 'Amount');

    const data = encodeFunctionData({
      abi: bridgeAdapterAbi,
      functionName: 'bridgeToken',
      args: [
        params.recipient as Address,
        BigInt(params.amount),
        params.destinationNetworkId,
        params.forceUpdateGlobalExitRoot,
      ],
    });

    const [nonce, gas] = await Promise.all([
      this.getNonce(from),
      this.estimateGas(data, this.bridgeAdapterAddress, from),
    ]);

    return {
      from,
      to: this.bridgeAdapterAddress,
      data,
      gas,
      nonce,
    };
  }
}
