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
availability), not on the tracker reaching `WaitingClaim`. `getClaimInputs`,
documented next, is exactly that check.

#### Claim Readiness & Claim Inputs

```typescript
// Resolve the proof inputs needed to claim a single bridge deposit.
// `recordingNetworkId` is the network whose LOCAL EXIT TREE recorded the
// deposit — from an `AggkitTransaction` row (e.g. from `getActivity` /
// `getReadyToClaimCount`) this is `transaction.sourceNetwork`, NOT the
// asset's `origin_network`.
const result = await aggregator.getClaimInputs({
  recordingNetworkId: transaction.sourceNetwork,
  destinationNetworkId: transaction.destinationNetwork,
  depositCount: transaction.depositCount,
});

if (!result.claimable) {
  // Not yet claimable is data, not an error: a well-formed request whose
  // deposit simply has not settled yet. `reason` is an OPEN union — always
  // keep a `default` branch, never an exhaustive `assertNever` switch.
  switch (result.reason) {
    case 'SOURCE_NOT_ON_L1_INFO_TREE':
      // still settling on the source network
      break;
    case 'DESTINATION_GER_NOT_INJECTED':
      // waiting for the destination to inject the global exit root
      break;
    default:
      // e.g. 'SYNCER_INCONSISTENT' (a syncer is resolving a reorg) — keep polling
      break;
  }
} else {
  // result.proof, result.leafIndex, result.sourceL1InfoTreeIndex
}
```

`getClaimInputs` throws **only** for genuine failures — `AggkitApiError` for
a real non-2xx response, a plain `Error` for a backend-contract violation or
a configuration problem, or a plain `Error` (its `.cause` carries the
original network error) for a transport failure after retries are
exhausted. A transport failure does **not** produce `AggkitApiError` — that
class is only ever constructed from an actual HTTP response, and a transport
failure never gets one; a caller branching on `instanceof AggkitApiError`
should treat the plain-`Error`/`.cause` case as a distinct outcome. It never
throws to signal "not ready yet"; not yet claimable is data, not an error,
and is always returned as the `{ claimable: false, reason, detail }` branch
above — there is no thrown not-ready state anywhere on this path.

**Routing.** `recordingNetworkId` is REQUIRED and keys the `network_id` sent
to both the L1-info-tree-index probe and the claim-proof call. It also keys
which aggkit instance answers **except** when `recordingNetworkId === 0`
(L1 has no dedicated instance): there, the destination L2's instance is used
instead, since it is the one that must also answer the injected-GER probe
(falling back to any configured instance if the destination itself isn't
configured). It is **not** the asset's `origin_network` — the two diverge for
native-gas-token withdrawals and for transfers of a token whose origin
differs from the network the transfer executed on. Passing `origin_network`
in those cases silently builds a well-formed proof for a different,
unrelated deposit, with no error raised anywhere. There is no
`originNetworkId` parameter to fall back to; it was removed rather than
deprecated, so a stale call site fails to compile instead of mis-routing at
runtime.

**Minimum supported aggkit: v0.11.0-rc6.** Earlier releases (rc4/rc5) are not
supported — this SDK does not attempt to classify their wire shapes, and a
deployment on rc4/rc5 will see a genuine failure (`AggkitApiError`) for any
not-ready state these endpoints report. On the supported floor, the client
absorbs aggkit's not-ready wire shapes across `/l1-info-tree-index`,
`/injected-l1-info-leaf`, and `/claim-proof` into the same stable
`AggkitNotReadyReason` values — a 404 with a fixed not-ready prose, or a 503
while a syncer resolves a reorg (`SYNCER_INCONSISTENT` — reachable from ALL
THREE of those endpoints, not just `/l1-info-tree-index`) — while any 500 on
any of the three is unconditionally a genuine fault and throws
`AggkitApiError`. `AggkitNotReadyReason` currently has five members:
`SOURCE_NOT_ON_L1_INFO_TREE` and `DESTINATION_GER_NOT_INJECTED` (shown in the
switch above), plus `SYNCER_INCONSISTENT`, `L1_INFO_LEAF_NOT_INDEXED` (the
destination's GER _is_ already injected; a different syncer is merely a few
blocks behind indexing that leaf), and `CLAIM_PROOF_NOT_AVAILABLE` (the
`/claim-proof` call itself is waiting on one of several syncers). The union
is open — see the `default` branch above.

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

## ⚠️ Breaking Changes

### `ChainRegistry.getChainByNetworkId()` registration precedence (base branch, commit `b9a990c`)

**Not introduced by this PR** — this shipped on the base branch
(`origin/feat/aggkit-bridge-client`), independent of anything in this fix
branch. Recorded here because its blast radius crosses module boundaries and
was otherwise undocumented (reviewer comment 3862898221).

`ChainRegistry.getChainByNetworkId()` now resolves networkId collisions with
consumer precedence in every case, not just when the consumer picks a
brand-new chainId. Previously, `defaultChainIds` was frozen at construction
and never cleared, so a consumer re-registering one of the SDK's own
built-in default chainIds (e.g. the real Sepolia chainId, `11155111`) stayed
flagged as a default alongside the SDK's pre-seeded entry for that same
networkId, and `getChainByNetworkId()` fell back to whichever of the two was
registered first — in practice, always the SDK's own default (e.g. Ethereum
mainnet at networkId 0), never the consumer's override. `registerChain()`
now deletes a chainId from `defaultChainIds` on every call, so any
re-registration — whether it introduces a brand-new chainId or reuses one of
the SDK's own defaults — immediately graduates that chainId to
consumer-registered status and wins the collision, independent of
registration order.

Consumers who register a chain at a networkId already used by an SDK
default, using the SDK's own default chainId for that chain, will now see
`getChainByNetworkId()` (and everything downstream of it) resolve to their
registration instead of the SDK default; this is the intended fix, but is a
behavior change for anyone who was relying on (or unaware of) the previous
frozen-defaults fallback. **The blast radius is not limited to aggkit**: it
includes the existing NATIVE path via `BridgeUtil.fromNetworkId`
(`src/native/bridge/bridge.ts:280`, `:307`, `:330`), which resolves chain
configuration for native bridge operations, in addition to
`AggkitBridgeAggregator.getTokenMetadata` (`src/aggkit/aggregator.ts`). Any
consumer relying on the old first-registered/frozen-defaults fallback for a
re-registered default chainId will see different resolution results after
this change.

### `AggkitBridgeAggregator.getClaimInputs` (this PR)

Two related breaking changes to this method:

1. **`originNetworkId` removed, `recordingNetworkId` now required.** The
   parameter was routing claim-proof lookups by the asset's `origin_network`,
   which silently builds a well-formed proof against the wrong network's
   exit tree for native-gas-token withdrawals and for cross-network
   transfers of a token whose origin differs from the network the transfer
   executed on (comment 3847422009). `originNetworkId` is declared as
   `never` rather than deprecated, so a stale call site is a compile error;
   a JS caller that still passes it gets a thrown migration `Error` at
   runtime. Replace `originNetworkId` with `recordingNetworkId` —
   `AggkitTransaction.sourceNetwork` from `getActivity`/`getReadyToClaimCount`
   rows — never the asset's `origin_network`.
2. **"Not yet claimable" changed from a thrown, fabricated `AggkitApiError`
   to a returned result union.** Previously a not-ready source or
   destination state was reported as a thrown `AggkitApiError` with an
   `httpStatus` that did not correspond to any real aggkit response
   (comments 3847523270 / 3847600104). `getClaimInputs` now returns
   `AggkitClaimInputsResult = AggkitClaimInputsReady | AggkitClaimInputsNotReady`
   (discriminated on `claimable`) — a not-ready deposit is
   `{ claimable: false, reason, detail }`, not a `catch` branch. Callers that
   wrapped `getClaimInputs` in a `try`/`catch` to detect "not ready yet" must
   switch to checking `result.claimable` instead; genuine failures (a real
   non-2xx response, a transport failure, or a config/contract violation)
   still throw.

### `AggkitBridgeAggregator.getActivity` / `getReadyToClaimCount` pagination + fan-out redesign (issues #30, #31)

Four related breaking changes, all in `src/aggkit/aggregator.ts` /
`src/aggkit/types.ts`:

1. **`AggkitActivityPage.pagination.total` is REMOVED; `exhausted: boolean`
   is added at the top level.** `total` summed each network's UNFILTERED
   `/bridges` count — it never reflected `fromAddress`-filtered rows, is
   unknowable across federated per-network sources without fetching
   everything, and the consumer (an infinite-scroll feed) never needed it.
   Check `page.exhausted` (or the presence of
   `page.pagination.nextStartAfterCursor`) instead of `page.pagination.total`.
2. **`AggkitPageCursor`'s per-entry shape changed** from a bare 1-based page
   number (`0` = exhausted sentinel) to an `AggkitSourceCursorState` object
   (`page`, `offset`, an optional `exhausted` flag), and it no longer has an
   entry per fan-out CALL — only per real FEED source
   (`` `${networkId}:bridgesOrigin` ``/`` `${networkId}:bridgesL1` ``; claims
   are no longer part of the pagination contract at all, see `types.ts`'s
   `AggkitSourceCursorState` doc). The value is still fully opaque — round-trip
   `nextStartAfterCursor` verbatim — but any code that inspected or
   hand-constructed a cursor must be updated. Cross-page ordering for
   `order: 'desc'` (the default) is now also GENUINELY correct (a real k-way
   merge with a per-source high-water cursor, replacing whole-page
   concatenation) and pages are now exactly `pageSize` rows instead of up to
   `2 x networks x pageSize`.
3. **`AggkitFailedNetwork[]` can now contain more than one entry per
   `networkId`.** Fan-out calls degrade `Promise.allSettled`-style PER CALL
   now, not per network (a failing claims list, for instance, no longer
   wipes that network's bridge rows out of `getActivity`) — code that assumed
   at most one entry per `networkId` must be updated to expect several.
4. **`getReadyToClaimCount` now returns an `AggkitReadyToClaimCountResult`
   object (`{ count, failedNetworks }`), not a bare `number`.** Previously
   every dropped per-row probe (a rate limit, a reset connection) silently
   folded into "not ready," under-counting the badge with zero signal
   anything went wrong; `failedNetworks` now surfaces those. Additionally
   (issue #31), the per-row predicate now applies the same
   destination-injected-GER gate `getActivity`'s `toTransaction` already
   applied — previously the count could include a deposit the activity list
   correctly reported as `LEAF_INCLUDED` (not yet claimable), and acting on
   the badge could build a claim proof that reverts on-chain with
   `GlobalExitRootInvalid`. Callers must switch from
   `const n = await getReadyToClaimCount(...)` to
   `const { count } = await getReadyToClaimCount(...)`.

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
