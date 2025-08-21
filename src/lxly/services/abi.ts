/**
 * ABI Service
 *
 * Centralized management of all contract ABIs
 */

import { bridgeAbi } from '../bridge/abi/bridge';
import { erc20Abi } from '../tokens/abi/erc20';

export const ABIS = {
  BRIDGE: bridgeAbi,
  ERC20: erc20Abi,
} as const;

export type ContractType = keyof typeof ABIS;

/**
 * Get ABI by contract type
 */
export function getAbi(contractType: ContractType) {
  return ABIS[contractType];
}

/**
 * Get specific function ABI
 */
export function getFunctionAbi(
  contractType: ContractType,
  functionName: string
) {
  const abi = ABIS[contractType];
  return abi.find(
    (item) => item.type === 'function' && item.name === functionName
  );
}

/**
 * Get specific event ABI
 */
export function getEventAbi(contractType: ContractType, eventName: string) {
  const abi = ABIS[contractType];
  return abi.find((item) => item.type === 'event' && item.name === eventName);
}
