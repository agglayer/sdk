# AggLayer SDK

[![License: Source Available](https://img.shields.io/badge/License-Source%20Available-blue.svg?style=flat-square)](./LICENSE-SOURCE-AVAILABLE)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![NPM Version](https://img.shields.io/npm/v/@agglayer/sdk?style=flat-square)](https://www.npmjs.com/package/@agglayer/sdk)

A comprehensive TypeScript SDK for interacting with the AggLayer ecosystem, providing seamless integration with ARC API services and blockchain operations. Engineered with enterprise-grade architecture, **flexible zero-config setup**, strict type safety, and exceptional developer experience.

## 🚀 Quick Start

### Installation

```bash
# Production (stable) - NOT YET AVAILABLE
npm install @agglayer/sdk

# Beta (testing)
npm install @agglayer/sdk@beta
```

### Basic Usage

```typescript
import { AggLayerSDK, SDK_MODES } from '@agglayer/sdk';

// 🎯 NEW: Flexible Configuration - Zero setup required!
// No configuration needed - uses intelligent defaults
const sdk = new AggLayerSDK();

// Or explicitly configure modes and settings
const sdkWithConfig = new AggLayerSDK({
  mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],
  core: {
    apiBaseUrl: 'https://api.agglayer.com',
    apiTimeout: 30000,
  },
  native: {
    defaultNetwork: 1, // Ethereum mainnet
  },
});

// Access modules
const core = sdk.getCore();
const native = sdkWithConfig.getNative();
```

## Usage Examples

### Core Module - ARC API Operations

The Core module provides high-level abstractions for AggLayer's ARC API, enabling route discovery, transaction building, and chain metadata management.

#### Chain & Token Metadata

```typescript
const core = sdk.getCore();

// Retrieve metadata for all supported chains
const chains = await core.getAllChains();
console.log(`Found ${chains.chains.length} supported chains`);

// Get specific chain metadata by Chain ID
const chainData = await core.getChainMetadataByChainIds([1, 137, 11155111]);
console.log('Chain metadata:', chainData);

// Get all tokens grouped by Chain (expensive operation - use sparingly)
const allTokens = await core.getAllTokens();

// Recommended: Get chain data with tokens for specific chains
const chainTokenData = await core.getChainDataAndTokensByChainIds([1, 137]);

// NOTE: All above functions manage pagination internally
```

#### Route Discovery & Transaction Building

```typescript
// Find optimal bridging routes
const routes = await core.getRoutes({
  fromChainId: 1, // Ethereum Mainnet
  toChainId: 137, // Polygon
  fromTokenAddress: '0xA0b86a33E6441b8c4C8C0e4b8c4C8C0e4b8c4C8C0',
  toTokenAddress: '0xB0b86a33E6441b8c4C8C0e4b8c4C8C0e4b8c4C8C0',
  amount: '1000000000000000000', // 1 token in wei
  fromAddress: '0x2254E4D1B41F2Dd3969a79b994E6ee8C3C6F2C71',
  slippage: 0.5, // 0.5% slippage tolerance
});

// Get unsigned transaction from route
const unsignedTx = await core.getUnsignedTransaction(routes);
console.log('Transaction data:', unsignedTx.data);

// Build claim transaction for completed bridge
const claimTx = await core.getClaimUnsignedTransaction({
  sourceNetworkId: 1,
  depositCount: 12345,
});
```

> NOTE: `getClaimUnsignedTransaction()` expects Agglayer Network ID, not Chain ID

#### Transaction History & Monitoring

```typescript
// Get transaction history with pagination
const transactions = await core.getTransactions({
  limit: 50,
  startAfter: 'nextStartAfterCursor', // cursor-based pagination
});

console.log(`Retrieved ${transactions.transactions.length} transactions`);
```

### Native Module - Blockchain Operations

The Native module provides direct blockchain interaction capabilities with agglayer chains.
Majority of interaction will happen via the `ERC20` class

#### Network & Balance Management

```typescript
const native = sdk.getNative();

const chainDetails = getNetwork(1);
// Get native token balance (ETH, MATIC, etc.)
const nativeBalance = await native.getNativeBalance(
  '0xFromAddress12345678901234567890123456789012345',
  1
);
console.log(`ETH balance: ${nativeBalance} wei`);

// Access chain registry for network information
const chainRegistry = native.getChainRegistry();
const ethereumConfig = chainRegistry.getChain(1);
const ethereumConfig = native.getNetwork(1); // OR for convinence
console.log(`RPC URL: ${sepoliaConfig.rpcUrl}`);
```

#### ERC20 Token Operations (balance, approve, transfer)

```typescript
// Create ERC20 instance for USDC on Sepolia
const usdc = native.erc20(
  '0x44499312f493F62f2DFd3C6435Ca3603EbFCeeBa',
  11155111
);

// Read operations
const balance = await usdc.getBalance(
  '0xFromAddress12345678901234567890123456789012345'
);
const allowance = await usdc.getAllowance(
  '0xFromAddress12345678901234567890123456789012345', // owner
  '0x1234567890123456789012345678901234567890' // spender
);

// Build approve transaction (not executed)
const approveTx = await usdc.buildApprove(
  '0xSpenderAddress1234567890123456789012345678901', // spender
  '1000000', // 1 USDC allowance
  '0xFromAddress12345678901234567890123456789012345' // from
);

// Build transaction parameters (not executed)
const transferTx = await usdc.buildTransfer(
  '0xRecipientAddress123456789012345678901234567890',
  '1000000', // 1 USDC (6 decimals)
  '0xFromAddress12345678901234567890123456789012345' // from
);

// Build transferFrom transaction
const transferFromTx = await usdc.buildTransferFrom(
  '0xFromAddress12345678901234567890123456789012345', // from
  '0xToAddress1234567890123456789012345678901234567', // to
  '500000', // 0.5 USDC
  '0xFromAddress12345678901234567890123456789012345' // spender
);
```

#### Cross-Chain Bridge Operations

```typescript
// Direct token bridging via ERC20 instance
const bridgeTx = await usdc.bridgeTo(
  137, // Polygon destination
  '0xRecipientOnPolygon1234567890123456789012345678',
  '1000000', // 1 USDC
  '0xFromAddress12345678901234567890123456789012345', // from
  {
    forceUpdateGlobalExitRoot: true,
    permitData: '0x', // optional permit data
  }
);

// Advanced bridge operations via Bridge instance
const bridge = native.bridge(
  '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582', // bridge contract
  11155111 // Sepolia
);

// Build bridge asset transaction
const bridgeAssetTx = await bridge.buildBridgeAsset(
  {
    destinationNetwork: 137,
    destinationAddress: '0xRecipientAddress123456789012345678901234567890',
    amount: '1000000000000000000', // 1 token in wei
    token: '0x44499312f493F62f2DFd3C6435Ca3603EbFCeeBa',
    forceUpdateGlobalExitRoot: true,
  },
  '0xFromAddress12345678901234567890123456789012345'
);

// Build claim transaction from bridge tx hash
const claimAssetTx = await bridge.buildClaimAssetFromHash(
  '0xBridgeTxHash123456789012345678901234567890123456789012345678',
  11155111, // source network where bridge tx occurred
  10000, // leaf index for the claim proof
  0, // bridge event index in tx (usually 0)
  '0xFromAddress12345678901234567890123456789012345' // claimer address
);

// Check if bridge deposit is already claimed
const isClaimed = await bridge.isClaimed({
  leafIndex: 12345,
  sourceBridgeNetwork: 11155111,
});

// Get wrapped token address on destination chain
const wrappedToken = await bridge.getWrappedTokenAddress({
  originNetwork: 11155111,
  originTokenAddress: '0x44499312f493F62f2DFd3C6435Ca3603EbFCeeBa',
});
```

#### Bridge Message Operations

```typescript
// Build bridge message transaction (for arbitrary data)
const bridgeMessageTx = await bridge.buildBridgeMessage(
  {
    destinationNetwork: 137,
    destinationAddress: '0xRecipientContract123456789012345678901234567',
    forceUpdateGlobalExitRoot: true,
    metadata: '0x1234', // arbitrary data payload
  },
  '0xFromAddress12345678901234567890123456789012345'
);

// Build claim message transaction from bridge tx hash
const claimMessageTx = await bridge.buildClaimMessageFromHash(
  '0xBridgeMessageTxHash12345678901234567890123456789012345678901234',
  11155111, // source network
  10000, // leaf index for the claim proof
  0, // message event index
  '0xFromAddress12345678901234567890123456789012345' // claimer
);
```

#### Bridge Transaction Tracking

```typescript
// Poll the aggkit bridge tracker for a single transaction's route/status,
// keyed by the SOURCE network id and the tx hash that created the bridge.
const trackingData = await aggregator.getBridgeTracking(
  11155111, // source network where the bridge tx occurred
  '0xBridgeTxHash123456789012345678901234567890123456789012345678'
);
```

The aggkit tracker (`tracker/v1`) has no push/subscription transport — only
this REST lookup — so callers must poll. ~5s between calls is a good
default (matches the dev-ui consumer). Stop polling as soon as either
terminal condition is met:

- `tracking_status === 'finished'`, or
- `tracking_status === 'error'` with `bridge_status: null` (the tracker gave
  up resolving the bridge at all — distinct from a step-level error, which
  reports `tracking_status: 'error'` too but with `bridge_status` populated
  and is retried by the tracker on its own).

Keep polling through any other non-terminal state, including a regression
back to `'registered'` with `all_steps: null` — the FIRST call for a given
`(networkId, txHash)` pair registers it with the tracker, and the tracker
is stateful with a bounded retention window (`RetentionPeriod`); if a
tracked-but-not-yet-terminal bridge is evicted, the next poll silently
re-registers it from scratch (`'registered'`, `all_steps: null` again)
rather than erroring.

`tracking_status`, `bridge_type`, and each step's `status`/`step_name` ship
as bare string unions on the wire — not a numeric value with a `_string`
companion field, unlike `error_type` and certificate `status`, which do
keep the int + `_string` pair. See the `AggkitTrackingData` /
`AggkitBridgeStepPath` JSDoc in `src/aggkit/types.ts` for the full
wire-format reference.

**Caveat ([agglayer/aggkit#1786](https://github.com/agglayer/aggkit/issues/1786), OPEN)**:
the tracker's `WaitingClaim` step routinely precedes actual claimability by
seconds to tens of seconds — it reflects only the tracker's own fast-path
read of the settlement tx's L1 receipt, not aggkit's separate bridge-service
L1-info-tree sync that a claim's proof fetch depends on. Gate claim-readiness
UX on your own check (e.g. the bridge-service's own status/proof
availability), not on the tracker reaching `WaitingClaim`.

## ⚙️ Configuration

### SDK Configuration Options

The SDK provides comprehensive configuration capabilities for both modules with sensible defaults and extensive customization options.

#### Complete Configuration Example

```typescript
import { AggLayerSDK, SDK_MODES } from '@agglayer/sdk';

const sdk = new AggLayerSDK({
  // Module Selection - Choose which modules to enable
  mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],

  // Core Module Configuration
  core: {
    // ARC API Configuration
    apiBaseUrl: 'https://api.agglayer.com', // Default: 'https://api.agglayer.com'
    apiTimeout: 30000, // Default: 30000 (30 seconds)
    // Implementation pending for websocket
    // websocketBaseUrl: 'wss://ws.agglayer.com', // Optional: For transactions history
  },

  // Native Module Configuration
  native: {
    // Default network for operations
    defaultNetwork: 1, // Default: 1 (Ethereum)

    // Custom chain configurations
    chains: [
      {
        chainId: 1,
        networkId: 1,
        name: 'Ethereum Mainnet',
        rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/your-api-key',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        blockExplorer: {
          name: 'Etherscan',
          url: 'https://etherscan.io',
        },
        bridgeAddress: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe',
        proofApiUrl: 'https://proof-api.polygonzkevmchain.com',
        isTestnet: false,
      },
      {
        chainId: 137,
        networkId: 137,
        name: 'Polygon Mainnet',
        rpcUrl: 'https://polygon-mainnet.g.alchemy.com/v2/your-api-key',
        nativeCurrency: {
          name: 'MATIC',
          symbol: 'MATIC',
          decimals: 18,
        },
        bridgeAddress: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe',
        isTestnet: false,
      },
    ],

    // Override RPC URLs for existing chains
    customRpcUrls: {
      1: 'https://your-premium-ethereum-rpc.com',
      137: 'https://your-premium-polygon-rpc.com',
      11155111: 'https://sepolia.infura.io/v3/your-project-id',
    },
  },
});
```

#### Core Module Configuration

```typescript
interface CoreConfig {
  apiBaseUrl?: string; // ARC API base URL
  apiTimeout?: number; // Request timeout in milliseconds
  // websocketBaseUrl?: string;  // WebSocket endpoint for real-time updates
}
```

**Default Values:**

- `apiBaseUrl`: `'https://arc-api.polygon.technology'`
- `apiTimeout`: `30000` (30 seconds)

#### Native Module Configuration

```typescript
interface NativeConfig {
  defaultNetwork?: number; // Default chain ID for operations
  chains?: ChainConfig[]; // Custom chain configurations
  customRpcUrls?: Record<number, string>; // Override RPC URLs by chain ID
}

interface ChainConfig {
  chainId: number; // EIP-155 chain identifier
  networkId: number; // Network identifier (usually same as chainId)
  name: string; // Human-readable chain name
  rpcUrl: string; // RPC endpoint URL
  nativeCurrency: {
    // Native token configuration
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorer?: {
    // Optional block explorer
    name: string;
    url: string;
  };
  bridgeAddress?: string; // Bridge contract address
  proofApiUrl?: string; // Proof generation API endpoint
  isTestnet?: boolean; // Network type flag
  isLocal?: boolean; // Local development network flag
}
```

**Default Values:**

- `defaultNetwork`: `1` (Ethereum mainnet)
- `chains`: Built-in registry with major networks
- `customRpcUrls`: `{}`

### Module-Specific Configurations

#### Core-Only Setup (API Integration)

```typescript
const coreOnlySDK = new AggLayerSDK({
  mode: [SDK_MODES.CORE],
  core: {
    apiBaseUrl: 'https://api.agglayer.com',
    apiTimeout: 45000, // Increased timeout for complex operations
    // websocketBaseUrl: 'wss://ws.agglayer.com'
  },
});

const core = coreOnlySDK.getCore();
```

#### Native-Only Setup (Blockchain Operations)

```typescript
const nativeOnlySDK = new AggLayerSDK({
  mode: [SDK_MODES.NATIVE],
  native: {
    defaultNetwork: 1, // Ethereum Mainnet
    customRpcUrls: {
      1: 'https://eth-mainnet.g.alchemy.com/v2/your-key',
      137: 'https://polygon-mainnet.g.alchemy.com/v2/your-key',
    },
  },
});

const native = nativeOnlySDK.getNative();
```

#### Environment-Specific Configurations

```typescript
// Development Configuration
const devConfig = {
  mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],
  core: {
    apiBaseUrl: 'http://localhost:3001', // Local development server
    apiTimeout: 10000,
  },
  native: {
    defaultNetwork: 11155111, // Sepolia testnet
    customRpcUrls: {
      11155111: 'http://localhost:8545', // Local Ethereum fork
    },
  },
};

// Production Configuration
const prodConfig = {
  mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],
  core: {
    apiBaseUrl: 'https://api.agglayer.com',
    apiTimeout: 30000,
  },
  native: {
    defaultNetwork: 1, // Ethereum Mainnet
    customRpcUrls: {
      1: process.env.ETHEREUM_RPC_URL,
      137: process.env.POLYGON_RPC_URL,
    },
  },
};

// Use environment-appropriate config
const config = process.env.NODE_ENV === 'production' ? prodConfig : devConfig;
const sdk = new AggLayerSDK(config);
```

### Built-in Chain Registry

The SDK includes a comprehensive registry of popular networks:

- **Ethereum Mainnet** (Chain ID: 1)
- **Katana** (Chain ID: 747474)
- **Sepolia Testnet** (Chain ID: 11155111)

<!-- - **Bokuto Testnet** (Chain ID: 2442) -->

Additional networks can be added via the `chains` configuration option.

## 🔧 Architecture & Design Principles

The SDK employs a **modular microservice architecture** with strict separation of concerns:

### Core Module (`SDK_MODES.CORE`)

Core module primarily supports the features based on ARC API

- **Chain Registry**: Comprehensive chain management
- **Route Discovery**: Intelligently find routes for bridging, across agglayer bridge and other aggregators
- **Transaction Orchestration**: Prepare unsigned executable transactions based on routes
- **Transactions Activity and History**: Track status of transactions to perform aadditional functions like claim or view history of transactions.

### Native Module (`SDK_MODES.NATIVE`)

Interact with blockchain and agglayer bridge directly, this does not involve any additional APIs(except for proof generation)

- **ERC20 Token Operations**: Standards-compliant token interactions(getBalance, getAllowance, buildApprove, etc)
- **Bridge Infrastructure**: Cross-chain asset transfer protocols (like bridgeTo, claimAsset, etc via ERC20 interface)

### Key Design Principles

- **Type-First Development**: 100% TypeScript with strict mode enabled
- **Flexible Configuration**: Zero-config defaults with progressive customization
- **Immutable Data Structures**: Predictable state management
- **Error-First Callbacks**: Comprehensive error handling patterns
- **Smart Defaults**: Intelligent fallbacks that work out-of-the-box
- **Modular Loading**: Tree-shakeable imports for optimized bundles

## � Release Channels & Versioning

The SDK follows semantic versioning with multiple release channels for different stability requirements:

| Channel  | Description                | Stability           | Installation                      | Use Case                        |
| -------- | -------------------------- | ------------------- | --------------------------------- | ------------------------------- |
| `latest` | Stable production releases | ✅ Production Ready | `npm install @agglayer/sdk`       | Production applications         |
| `beta`   | Release candidates         | ⚠️ Testing          | `npm install @agglayer/sdk@beta`  | Pre-production testing          |
| `alpha`  | Early feature previews     | 🚧 Experimental     | `npm install @agglayer/sdk@alpha` | Feature development             |
| `dev`    | Internal use               | 🔧 Development      | `npm install @agglayer/sdk@dev`   | SDK development & bleeding edge |

### Release Strategy

- **Stable releases** (`v1.0.0`, `v2.0.0`): Thoroughly tested, API-stable versions
- **Beta releases** (`v1.0.0-beta.1`): Feature-complete candidates with minimal changes expected
- **Alpha releases** (`v1.0.0-alpha.1`): Early access to new features, API may change
- **Dev releases** (`v1.0.0-dev.1`): Internal use

## Quick Reference

### Common Configuration Patterns

```typescript
// Development with testnet
const devSdk = new AggLayerSDK({
  mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],
  core: {
    apiBaseUrl: 'https://api-testnet.agglayer.com',
  },
  native: {
    defaultNetwork: 11155111, // Sepolia testnet
  },
});

// Production with custom timeouts
const prodSdk = new AggLayerSDK({
  core: {
    apiTimeout: 60000, // 60 second timeout
  },
});

// Multi-chain setup
const multiChainSdk = new AggLayerSDK({
  mode: [SDK_MODES.NATIVE],
  native: {
    defaultNetwork: 1,
    customRpcUrls: {
      1: 'https://ethereum-mainnet.infura.io/v3/YOUR_KEY',
      137: 'https://polygon-mainnet.infura.io/v3/YOUR_KEY',
      42161: 'https://arbitrum-mainnet.infura.io/v3/YOUR_KEY',
    },
  },
});
```

## 🔧 Development & Contributing

### Prerequisites

- **Node.js** 18+ or **Bun** 1.0+
- **TypeScript** 4.9+
- **Git** for version control

### Local Development Setup

```bash
# Clone the repository
git clone https://github.com/agglayer/sdk.git
cd sdk

# Install dependencies (npm, yarn, or bun)
npm install
# or
bun install

# Build the project
npm run build

# Start development mode with hot reload
npm run dev
```

### Available Development Scripts

| Script                  | Description                                | Usage                                 |
| ----------------------- | ------------------------------------------ | ------------------------------------- |
| `npm run build`         | Production build with optimizations        | CI/CD and release preparation         |
| `npm run dev`           | Development build with watch mode          | Local development with hot reload     |
| `npm run typecheck`     | TypeScript type checking without emit      | Validate types before commits         |
| `npm run test`          | Run complete test suite                    | Continuous testing during development |
| `npm run test:run`      | Single test run without watch              | CI/CD pipeline testing                |
| `npm run test:coverage` | Generate test coverage reports             | Quality assurance metrics             |
| `npm run test:watch`    | Interactive test runner with file watching | TDD development workflow              |
| `npm run lint`          | ESLint code quality analysis               | Code style enforcement                |
| `npm run lint:fix`      | Auto-fix ESLint issues                     | Automated code style corrections      |
| `npm run format`        | Prettier code formatting                   | Consistent code style across codebase |
| `npm run format:check`  | Validate code formatting                   | CI/CD formatting verification         |
| `npm run clean`         | Remove build artifacts                     | Clean slate rebuilds                  |

## 🚨 Error Handling & Debugging

### Comprehensive Error Types

The SDK provides detailed error information for all failure scenarios:

```typescript
try {
  const routes = await core.getRoutes({
    fromChainId: 1,
    toChainId: 137,
    fromTokenAddress: '0xinvalid',
    toTokenAddress: '0x...',
    amount: '1000000000000000000',
    fromAddress: '0x...',
  });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Input validation failed:', error.message);
    console.error('Field:', error.field);
    console.error('Value:', error.value);
  } else if (error instanceof NetworkError) {
    console.error('Network request failed:', error.message);
    console.error('Status:', error.status);
    console.error('Endpoint:', error.url);
  } else if (error instanceof ContractError) {
    console.error('Contract interaction failed:', error.message);
    console.error('Contract:', error.address);
    console.error('Function:', error.functionName);
  }
}
```

## 📈 Roadmap & Future Development

### Upcoming Features

- User input validations
- Runtime api response validation using zod
- WebSocket support for real-time updates of transactions and their status

---

<div align="center">

**Built with ❤️ by the AggLayer Team**

[⭐ Star us on GitHub](https://github.com/agglayer/sdk) • [🐛 Report Issues](https://github.com/agglayer/sdk/issues)

</div>
