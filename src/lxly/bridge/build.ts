/**
 * Bridge Build Functions
 *
 * Functions to build bridge transaction parameters
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import { bridgeAbi } from './abi/bridge';
import type { TransactionParams } from '../../types';

export interface BuildContext {
  bridgeAddress: string;
  estimateGas: (data: Hex, to: string, from?: string) => Promise<string>;
  getNonce: (address?: string) => Promise<string | undefined>;
}

export async function buildBridgeAsset(
  ctx: BuildContext,
  destinationNetwork: number,
  destinationAddress: Address,
  amount: bigint,
  token: Address,
  forceUpdateGlobalExitRoot: boolean,
  permitData: string = '0x',
  from?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: bridgeAbi,
    functionName: 'bridgeAsset',
    args: [
      destinationNetwork,
      destinationAddress,
      amount,
      token,
      forceUpdateGlobalExitRoot,
      permitData as Hex,
    ],
  });

  const [nonce, gas] = await Promise.all([
    ctx.getNonce(from),
    ctx.estimateGas(data, ctx.bridgeAddress, from),
  ]);

  return {
    from,
    to: ctx.bridgeAddress,
    data,
    gas,
    nonce,
  };
}

export async function buildClaimAsset(
  ctx: BuildContext,
  smtProofLocalExitRoot: readonly `0x${string}`[], // Array of 32 bytes32 values
  smtProofRollupExitRoot: readonly `0x${string}`[], // Array of 32 bytes32 values
  globalIndex: bigint,
  mainnetExitRoot: `0x${string}`, // bytes32
  rollupExitRoot: `0x${string}`, // bytes32
  originNetwork: number,
  originTokenAddress: Address,
  destinationNetwork: number,
  destinationAddress: Address,
  amount: bigint,
  metadata: `0x${string}`, // bytes
  from?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: bridgeAbi,
    functionName: 'claimAsset',
    args: [
      // @ts-ignore - Viem expects exact tuple types but we're passing arrays
      smtProofLocalExitRoot,
      // @ts-ignore - Viem expects exact tuple types but we're passing arrays
      smtProofRollupExitRoot,
      globalIndex,
      mainnetExitRoot,
      rollupExitRoot,
      originNetwork,
      originTokenAddress,
      destinationNetwork,
      destinationAddress,
      amount,
      metadata,
    ],
  });

  const [nonce, gas] = await Promise.all([
    ctx.getNonce(from),
    ctx.estimateGas(data, ctx.bridgeAddress, from),
  ]);

  return {
    from,
    to: ctx.bridgeAddress,
    data,
    gas,
    nonce,
  };
}
