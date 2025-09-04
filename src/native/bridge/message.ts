/**
 * Bridge Message Build Functions
 *
 * Functions to build bridge message transaction parameters
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import { bridgeAbi } from './abi/bridge';
import type { TransactionParams } from '@/types';

export interface BuildContext {
  bridgeAddress: string;
  estimateGas: (data: Hex, to: string, from?: string) => Promise<string>;
  getNonce: (address?: string) => Promise<string | undefined>;
}

export async function buildBridgeMessage(
  ctx: BuildContext,
  destinationNetwork: number,
  destinationAddress: Address,
  forceUpdateGlobalExitRoot: boolean,
  permitData: string = '0x',
  from?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: bridgeAbi,
    functionName: 'bridgeMessage',
    args: [
      destinationNetwork,
      destinationAddress,
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

export async function buildClaimMessage(
  ctx: BuildContext,
  smtProofLocalExitRoot: readonly `0x${string}`[],
  smtProofRollupExitRoot: readonly `0x${string}`[],
  globalIndex: bigint,
  mainnetExitRoot: `0x${string}`,
  rollupExitRoot: `0x${string}`,
  originNetwork: number,
  originTokenAddress: Address,
  destinationNetwork: number,
  destinationAddress: Address,
  amount: bigint,
  metadata: `0x${string}`,
  from?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: bridgeAbi,
    functionName: 'claimMessage',
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
