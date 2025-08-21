/**
 * Bridge Adapter ABI
 *
 * Polygon ZkEVM Bridge Adapter contract ABI for custom ERC20 bridging
 */

export const bridgeAdapterAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'recipient', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint32', name: 'destinationNetworkId', type: 'uint32' },
      { internalType: 'bool', name: 'forceUpdateGlobalExitRoot', type: 'bool' },
    ],
    name: 'bridgeToken',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;
