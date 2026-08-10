/**
 * Chain Registry
 *
 * Centralized chain configuration management
 */

import { type Chain } from 'viem';

import type { ChainConfig, CustomChainConfig } from '@/types';

export class ChainRegistry {
  private static instance: ChainRegistry;
  private chains: Map<number, ChainConfig> = new Map();
  private viemChains: Map<number, Chain> = new Map();
  // chainIds seeded by `initializeDefaultChains()` at construction time.
  // Fixed once, at construction — never mutated afterwards, even if a
  // consumer later re-registers one of these chainIds (see `registerChain`
  // precedence note below). Used by `getChainByNetworkId` to make
  // consumer-registered chains win over built-in defaults on networkId
  // collisions (e.g. a devnet L1 registered at networkId 0 vs. the
  // pre-seeded Ethereum mainnet default, also at networkId 0).
  private readonly defaultChainIds = new Set<number>();

  private constructor() {
    this.initializeDefaultChains();
  }

  static getInstance(): ChainRegistry {
    if (!ChainRegistry.instance) {
      ChainRegistry.instance = new ChainRegistry();
    }
    return ChainRegistry.instance;
  }

  // DEV: if adding new default chains, also update README.md
  private initializeDefaultChains() {
    // Ethereum Mainnet
    this.registerDefaultChain({
      chainId: 1,
      networkId: 0,
      name: 'Ethereum',
      rpcUrl: 'https://eth.llamarpc.com',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorer: { name: 'Etherscan', url: 'https://etherscan.io' },
      bridgeAddress: '',
      proofApiUrl: 'https://bridge-hub-api.polygon.technology/mainnet/',
      isTestnet: false,
    });

    // Katana
    this.registerDefaultChain({
      chainId: 747474,
      networkId: 20,
      name: 'Katana',
      rpcUrl: 'https://rpc.katana.network',
      nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
      blockExplorer: {
        name: 'Katana Explorer',
        url: 'https://katanascan.com',
      },
      bridgeAddress: '',
      proofApiUrl: 'https://bridge-hub-api.polygon.technology/mainnet/',
      isTestnet: false,
    });

    // Ethereum Sepolia Testnet
    this.registerDefaultChain({
      chainId: 11155111,
      networkId: 0,
      name: 'Ethereum Sepolia',
      rpcUrl: 'https://rpc.sepolia.org',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      blockExplorer: {
        name: 'Sepolia Etherscan',
        url: 'https://sepolia.etherscan.io',
      },
      bridgeAddress: '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582',
      proofApiUrl: 'https://bridge-hub-api.polygon.technology/testnet/',
      isTestnet: true,
    });

    // todo: add bokuto testnet details
  }

  /**
   * Register a new chain.
   *
   * Precedence note: chains registered here (by a consumer, at any point
   * after construction) always take precedence over the SDK's built-in
   * defaults (registered via `initializeDefaultChains()`/
   * `registerDefaultChain()`) when `getChainByNetworkId()` resolves a
   * networkId collision — regardless of registration order. See
   * `getChainByNetworkId()`.
   */
  registerChain(config: ChainConfig): void {
    this.chains.set(config.chainId, config);

    // Create viem chain object
    const viemChain: Chain = {
      id: config.chainId,
      name: config.name,
      nativeCurrency: config.nativeCurrency,
      rpcUrls: {
        default: { http: [config.rpcUrl] },
      },
    };

    this.viemChains.set(config.chainId, viemChain);
  }

  /**
   * Register a built-in default chain (used only by
   * `initializeDefaultChains()`). Identical to `registerChain()`, plus
   * marking the chainId as a default for `getChainByNetworkId()`
   * precedence purposes.
   */
  private registerDefaultChain(config: ChainConfig): void {
    this.registerChain(config);
    this.defaultChainIds.add(config.chainId);
  }

  /**
   * Get chain configuration by ID
   */
  getChain(chainId: number): ChainConfig {
    const chain = this.chains.get(chainId);
    if (!chain) {
      throw new Error(
        `Chain ${chainId} not found. Available chains: ${Array.from(this.chains.keys()).join(', ')}`
      );
    }
    return chain;
  }

  /**
   * Get chain configuration by network ID.
   *
   * Precedence: multiple registered chains can share a `networkId` (e.g. a
   * consumer-registered devnet L1 and the SDK's pre-seeded Ethereum mainnet
   * default both at networkId 0, keyed by distinct chainIds). When that
   * happens, a consumer-registered chain always wins over a built-in
   * default, independent of registration order — a default is only
   * returned when no consumer-registered chain shares the networkId.
   * Ties among multiple consumer-registered (or multiple default) chains
   * fall back to first-registered, matching prior behavior.
   */
  getChainByNetworkId(networkId: number): ChainConfig {
    const matches = Array.from(this.chains.values()).filter(
      (chain) => chain.networkId === networkId
    );
    const chain =
      matches.find((chain) => !this.defaultChainIds.has(chain.chainId)) ??
      matches[0];
    if (!chain) {
      throw new Error(
        `Chain with network ID ${networkId} not found. Available network IDs: ${Array.from(
          this.chains.values()
        )
          .map((chain) => chain.networkId)
          .filter(Boolean)
          .join(', ')}`
      );
    }
    return chain;
  }

  /**
   * Get viem chain object by ID
   */
  getViemChain(chainId: number): Chain {
    const chain = this.viemChains.get(chainId);
    if (!chain) {
      throw new Error(
        `Chain ${chainId} not found. Available chains: ${Array.from(this.viemChains.keys()).join(', ')}`
      );
    }
    return chain;
  }

  /**
   * Get all registered chain IDs
   */
  getSupportedChainIds(): number[] {
    return Array.from(this.chains.keys());
  }

  /**
   * Get all registered chains
   */
  getAllChains(): ChainConfig[] {
    return Array.from(this.chains.values());
  }

  /**
   * Check if chain is supported
   */
  isChainSupported(chainId: number): boolean {
    return this.chains.has(chainId);
  }

  /**
   * Check if chain is supported by network ID
   */
  isChainSupportedByNetworkId(networkId: number): boolean {
    return Array.from(this.chains.values()).some(
      (chain) => chain.networkId === networkId
    );
  }

  /**
   * Get chains by type
   */
  getChainsByType(type: 'mainnet' | 'testnet' | 'local'): ChainConfig[] {
    return Array.from(this.chains.values()).filter((chain) => {
      if (type === 'mainnet') {
        return (
          !(chain as CustomChainConfig).isTestnet &&
          !(chain as CustomChainConfig).isLocal
        );
      }
      if (type === 'testnet') {
        return (chain as CustomChainConfig).isTestnet;
      }
      if (type === 'local') {
        return (chain as CustomChainConfig).isLocal;
      }
      return false;
    });
  }

  /**
   * Add custom RPC URL for existing chain
   */
  addCustomRpcUrl(chainId: number, rpcUrl: string): void {
    const chain = this.getChain(chainId);
    const customChain: ChainConfig = {
      ...chain,
      rpcUrl,
    };

    this.registerChain(customChain);
  }
}

// Export singleton instance
export const chainRegistry = ChainRegistry.getInstance();
