import { encodeFunctionData, type Address, type Hex } from 'viem';
import { erc20Abi } from './abi/erc20';
import type { TransactionParams } from './types';

export interface BuildContext {
  tokenAddress: string;
  estimateGas: (data: Hex, from?: string) => Promise<string>;
  getNonce: (address?: string) => Promise<string | undefined>;
}

export async function buildApprove(
  ctx: BuildContext,
  spender: Address,
  amount: bigint,
  from?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });

  const [nonce, gas] = await Promise.all([
    ctx.getNonce(from),
    ctx.estimateGas(data, from),
  ]);

  return {
    from,
    to: ctx.tokenAddress,
    data,
    gas,
    nonce,
  };
}

export async function buildTransfer(
  ctx: BuildContext,
  to: Address,
  amount: bigint,
  from?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  });

  const [nonce, gas] = await Promise.all([
    ctx.getNonce(from),
    ctx.estimateGas(data, from),
  ]);

  return {
    from,
    to: ctx.tokenAddress,
    data,
    gas,
    nonce,
  };
}

export async function buildTransferFrom(
  ctx: BuildContext,
  fromAddress: Address,
  to: Address,
  amount: bigint,
  spender?: string
): Promise<TransactionParams> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [fromAddress, to, amount],
  });

  const [nonce, gas] = await Promise.all([
    ctx.getNonce(spender),
    ctx.estimateGas(data, spender),
  ]);

  return {
    from: spender,
    to: ctx.tokenAddress,
    data,
    gas,
    nonce,
  };
}
