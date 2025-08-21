/**
 * Bridge ABI
 *
 * Polygon ZkEVM Bridge contract ABI
 */

export const bridgeAbi = [
  {
    inputs: [
      { internalType: 'uint32', name: 'destinationNetwork', type: 'uint32' },
      { internalType: 'address', name: 'destinationAddress', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'address', name: 'token', type: 'address' },
      { internalType: 'bool', name: 'forceUpdateGlobalExitRoot', type: 'bool' },
      { internalType: 'bytes', name: 'permitData', type: 'bytes' },
    ],
    name: 'bridgeAsset',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32[32]',
        name: 'smtProofLocalExitRoot',
        type: 'bytes32[32]',
      },
      {
        internalType: 'bytes32[32]',
        name: 'smtProofRollupExitRoot',
        type: 'bytes32[32]',
      },
      { internalType: 'uint256', name: 'globalIndex', type: 'uint256' },
      { internalType: 'bytes32', name: 'mainnetExitRoot', type: 'bytes32' },
      { internalType: 'bytes32', name: 'rollupExitRoot', type: 'bytes32' },
      { internalType: 'uint32', name: 'originNetwork', type: 'uint32' },
      { internalType: 'address', name: 'originTokenAddress', type: 'address' },
      { internalType: 'uint32', name: 'destinationNetwork', type: 'uint32' },
      { internalType: 'address', name: 'destinationAddress', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'bytes', name: 'metadata', type: 'bytes' },
    ],
    name: 'claimAsset',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint32', name: 'leafIndex', type: 'uint32' },
      { internalType: 'uint32', name: 'sourceBridgeNetwork', type: 'uint32' },
    ],
    name: 'isClaimed',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint32', name: 'originNetwork', type: 'uint32' },
      { internalType: 'address', name: 'originTokenAddress', type: 'address' },
    ],
    name: 'getTokenWrappedAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint32', name: 'destinationNetwork', type: 'uint32' },
      { internalType: 'address', name: 'destinationAddress', type: 'address' },
      { internalType: 'bool', name: 'forceUpdateGlobalExitRoot', type: 'bool' },
      { internalType: 'bytes', name: 'permitData', type: 'bytes' },
    ],
    name: 'bridgeMessage',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32[32]',
        name: 'smtProofLocalExitRoot',
        type: 'bytes32[32]',
      },
      {
        internalType: 'bytes32[32]',
        name: 'smtProofRollupExitRoot',
        type: 'bytes32[32]',
      },
      { internalType: 'uint256', name: 'globalIndex', type: 'uint256' },
      { internalType: 'bytes32', name: 'mainnetExitRoot', type: 'bytes32' },
      { internalType: 'bytes32', name: 'rollupExitRoot', type: 'bytes32' },
      { internalType: 'uint32', name: 'originNetwork', type: 'uint32' },
      { internalType: 'address', name: 'originTokenAddress', type: 'address' },
      { internalType: 'uint32', name: 'destinationNetwork', type: 'uint32' },
      { internalType: 'address', name: 'destinationAddress', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'bytes', name: 'metadata', type: 'bytes' },
    ],
    name: 'claimMessage',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint32', name: 'originNetwork', type: 'uint32' },
      { internalType: 'address', name: 'originTokenAddress', type: 'address' },
    ],
    name: 'precalculatedWrapperAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'wrappedToken', type: 'address' },
    ],
    name: 'wrappedTokenToTokenInfo',
    outputs: [
      { internalType: 'uint32', name: 'originNetwork', type: 'uint32' },
      { internalType: 'address', name: 'originTokenAddress', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'networkID',
    outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint8',
        name: 'leafType',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'originNetwork',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'originAddress',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'destinationNetwork',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'destinationAddress',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'depositCount',
        type: 'uint32',
      },
    ],
    name: 'BridgeEvent',
    type: 'event',
  },
] as const;
