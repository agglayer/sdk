# AggLayer SDK

A TypeScript SDK for interacting with AggLayer.

## Installation

```bash
npm install agglayer-sdk
```

## Usage

```typescript
import { AggLayerSDK } from 'agglayer-sdk';

const sdk = new AggLayerSDK();
```

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Available Scripts

- `npm run build` - Build the library
- `npm run dev` - Build in watch mode
- `npm run test` - Run tests
- `npm run test:coverage` - Run tests with coverage
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues
- `npm run format` - Format code with Prettier
- `npm run typecheck` - Type check with TypeScript

### Initialize SDK

```typescript
import { AggLayerSDK } from 'agglayer-sdk';

const sdk = new AggLayerSDK({
  mode: ['native'],
  native: {
    defaultNetwork: 11155111,
    chains: [
      {
        id: 11155111,
        name: 'Ethereum Sepolia',
        rpcUrl: 'https://rpc.sepolia.org',
        nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      },
    ],
    customRpcUrls: {
      1: 'https://your-custom-eth-rpc.com',
      137: 'https://your-custom-polygon-rpc.com',
    },
  },
});
```

### Read Operation - Get Token Balance

```typescript
// Get Native client
const native = sdk.getNative();

// Create ERC20 instance
const erc20 = native.erc20(
  '0x1234567890123456789012345678901234567890',
  11155111
);

// Get balance
const balance = await erc20.getBalance(
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
);
console.log('Balance:', balance); // Returns balance in wei as string
```

### Write Operation - Build Transfer Transaction

```typescript
// Create ERC20 instance
const erc20 = native.erc20(
  '0x1234567890123456789012345678901234567890',
  11155111
);

// Build transfer transaction
const transaction = await erc20.buildTransfer(
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', // recipient
  '1000000000000000000', // amount in wei
  '0x1111111111111111111111111111111111111111' // from address
);

console.log('Transaction:', transaction);
// Returns: { to, data, gas, maxFeePerGas, maxPriorityFeePerGas, nonce }
```

## Features

- **ERC20 Operations**: Balance, allowance, transfers, approvals
- **Transaction Building**: Build transactions for MetaMask or other wallets
- **Multi-Chain Support**: Support for multiple blockchain networks
- **TypeScript**: Full TypeScript support with type safety
- **Lightweight**: Minimal dependencies, focused on core functionality

### Code Quality

This project uses:

- **ESLint** for code linting with strict TypeScript rules
- **Prettier** for code formatting
- **Vitest** for testing
- **Husky** for git hooks
- **TypeScript** with strict configuration

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm run test`
5. Run linting: `npm run lint`
6. Submit a pull request

## License

ISC
