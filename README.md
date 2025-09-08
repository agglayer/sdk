# AggLayer SDK

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg?style=flat-square)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black?style=flat-square&logo=bun)](https://bun.sh/)

A comprehensive TypeScript SDK for interacting with AggLayer's ARC API and blockchain operations. Built with modular architecture, type safety, and developer experience in mind.

## 🚀 Quick Start

### Installation

```bash
# Install latest stable version
npm install @agglayer/sdk

# Install beta version (for testing)
npm install @agglayer/sdk@beta

# Install alpha version (experimental)
npm install @agglayer/sdk@alpha
```

### Basic Usage

```typescript
import { AggLayerSDK } from '@agglayer/sdk';

// Initialize SDK with default Core module
const sdk = new AggLayerSDK();
```

## 📋 Release Channels

| Channel  | Description                        | Stability           | Usage                             |
| -------- | ---------------------------------- | ------------------- | --------------------------------- |
| `latest` | Stable releases from `main` branch | ✅ Production Ready | `npm install @agglayer/sdk`       |
| `beta`   | Prereleases from `develop` branch  | ⚠️ Testing          | `npm install @agglayer/sdk@beta`  |
| `alpha`  | Early development releases         | 🚧 Experimental     | `npm install @agglayer/sdk@alpha` |

## 🏗️ Architecture

The SDK is built with a modular architecture supporting two main modules:

### Core Module

- **ARC API Integration**: Interact with AggLayer's REST API
- **Chain Metadata**: Retrieve supported chains and tokens
- **Route Discovery**: Find optimal bridging routes
- **Transaction Building**: Build complex multi-step transactions

### Native Module

- **ERC20 Operations**: Token balance, transfers, approvals
- **Bridge Operations**: Cross-chain bridge interactions
- **Multi-Chain Support**: Work with multiple blockchain networks
- **Raw Wei Handling**: All amounts returned as unformatted Wei strings

## 📖 Usage Examples

### Core Module - API Operations

```typescript
// Get Core client
const core = sdk.getCore();

// Retrieve all supported chains
const chains = await core.getAllChains();
console.log('Supported chains:', chains);

// Get chain metadata for specific networks
const chainData = await core.getChainMetadataByChainIds([1, 137, 11155111]);
console.log('Chain metadata:', chainData);

// Find bridging routes
const routes = await core.getRoutes({
  fromChainId: 1,
  toChainId: 137,
  fromTokenAddress: '0xA0b86a33E6441b8c4C8C0e4b8c4C8C0e4b8c4C8C0',
  toTokenAddress: '0xB0b86a33E6441b8c4C8C0e4b8c4C8C0e4b8c4C8C0',
  amount: '1000000000000000000', // 1 token in wei
  fromAddress: '0x1234567890123456789012345678901234567890',
});

// Build transaction from route steps
const transaction = await core.buildTransaction({
  steps: routes.steps,
  fromAddress: '0x1234567890123456789012345678901234567890',
});
```

### Native Module - Blockchain Operations

```typescript
// Get Native client
const native = sdk.getNative();

// Get native token balance
const nativeBalance = await native.getNativeBalance(
  '0x1234567890123456789012345678901234567890',
  11155111 // Sepolia
);
console.log('Native balance (wei):', nativeBalance);

// Create ERC20 instance
const erc20 = native.erc20(
  '0x1234567890123456789012345678901234567890', // USDC on Sepolia
  11155111
);

// Get ERC20 token balance
const tokenBalance = await erc20.getBalance(
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
);
console.log('Token balance (wei):', tokenBalance);

// Build transfer transaction
const transferTx = await erc20.buildTransfer(
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', // recipient
  '1000000000', // 1000 USDC (6 decimals) in wei
  '0x1111111111111111111111111111111111111111' // from address
);

// Build approval transaction
const approvalTx = await erc20.buildApprove(
  '0x2222222222222222222222222222222222222222', // spender
  '1000000000', // amount in wei
  '0x1111111111111111111111111111111111111111' // from address
);
```

### Bridge Operations

```typescript
// Create bridge instance
const bridge = native.bridge(
  '0x3333333333333333333333333333333333333333', // bridge contract
  11155111 // Sepolia
);

// Build bridge transaction
const bridgeTx = await bridge.buildBridgeTransaction({
  toChainId: 137, // Polygon
  tokenAddress: '0x1234567890123456789012345678901234567890',
  amount: '1000000000',
  recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  fromAddress: '0x1111111111111111111111111111111111111111',
});
```

## ⚙️ Configuration

### SDK Configuration

```typescript
import { AggLayerSDK, SDK_MODES } from '@agglayer/sdk';

const sdk = new AggLayerSDK({
  mode: [SDK_MODES.CORE, SDK_MODES.NATIVE], // Enable both modules
  core: {
    apiBaseUrl: 'https://api.agglayer.com',
    apiTimeout: 30000, // 30 seconds
  },
  native: {
    defaultNetwork: 11155111, // Default chain ID
    chains: [
      {
        id: 1,
        name: 'Ethereum Mainnet',
        rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/your-key',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      {
        id: 137,
        name: 'Polygon',
        rpcUrl: 'https://polygon-rpc.com',
        nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      },
    ],
    customRpcUrls: {
      1: 'https://your-custom-eth-rpc.com',
      137: 'https://your-custom-polygon-rpc.com',
    },
  },
});
```

### Module-Specific Usage

```typescript
// Core-only configuration
const coreOnlySdk = new AggLayerSDK({
  mode: [SDK_MODES.CORE],
  core: {
    apiBaseUrl: 'https://api.agglayer.com',
  },
  native: {} as any, // Required but unused
});

// Native-only configuration
const nativeOnlySdk = new AggLayerSDK({
  mode: [SDK_MODES.NATIVE],
  core: {} as any, // Required but unused
  native: {
    defaultNetwork: 11155111,
    chains: [
      /* your chains */
    ],
  },
});
```

## 🔧 Development

### Prerequisites

- Node.js 18+
- npm or bun

### Setup

```bash
# Clone the repository
git clone https://github.com/agglayer/sdk.git
cd sdk

# Install dependencies
npm install

# Build the project
npm run build
```

### Available Scripts

| Script                  | Description                         |
| ----------------------- | ----------------------------------- |
| `npm run build`         | Build the library for production    |
| `npm run dev`           | Build in watch mode for development |
| `npm run test`          | Run test suite                      |
| `npm run test:coverage` | Run tests with coverage report      |
| `npm run test:watch`    | Run tests in watch mode             |
| `npm run lint`          | Run ESLint                          |
| `npm run lint:fix`      | Fix ESLint issues automatically     |
| `npm run format`        | Format code with Prettier           |
| `npm run format:check`  | Check code formatting               |
| `npm run typecheck`     | Type check with TypeScript          |

### Testing

```bash
# Run all tests
npm run test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## 🎯 Key Features

### Type Safety

- Full TypeScript support with strict configuration
- Comprehensive type definitions for all operations
- IntelliSense support for better developer experience

### Modular Design

- **Core Module**: ARC API integration for route discovery and transaction building
- **Native Module**: Direct blockchain interactions for ERC20 and bridge operations
- Flexible configuration allowing module-specific usage

### Multi-Chain Support

- Built-in support for major EVM chains
- Custom chain configuration
- Custom RPC URL support
- Chain registry for easy network management

### Raw Wei Handling

- All token amounts returned as unformatted Wei strings
- No automatic decimal conversion for precision control
- Consistent number formatting across all operations

### Lightweight & Efficient

- Minimal dependencies (only viem for blockchain interactions)
- Tree-shakeable modules
- Optimized bundle size

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/your-feature-name`
3. **Make your changes** following our coding standards
4. **Run tests**: `npm run test`
5. **Run linting**: `npm run lint`
6. **Format code**: `npm run format`
7. **Submit a pull request**

### Code Quality Standards

- **TypeScript**: Strict type checking enabled
- **ESLint**: Enforced code quality rules
- **Prettier**: Consistent code formatting
- **Vitest**: Comprehensive test coverage
- **Husky**: Pre-commit hooks for quality assurance

## 📄 License

ISC License - see [LICENSE](LICENSE) file for details.

## 🔗 Links

- [GitHub Repository](https://github.com/agglayer/sdk)
- [NPM Package](https://www.npmjs.com/package/@agglayer/sdk)
- [Documentation](https://docs.agglayer.com)
- [Issues](https://github.com/agglayer/sdk/issues)
