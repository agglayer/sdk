/**
 * Chain Registry
 *
 * Centralized chain configuration management
 */

import { type Chain } from 'viem';

import type { ChainConfig, CustomChainConfig } from '../../types';

export class ChainRegistry {
  private static instance: ChainRegistry;
  private chains: Map<number, ChainConfig> = new Map();
  private viemChains: Map<number, Chain> = new Map();

  private constructor() {
    this.initializeDefaultChains();
  }

  static getInstance(): ChainRegistry {
    if (!ChainRegistry.instance) {
      ChainRegistry.instance = new ChainRegistry();
    }
    return ChainRegistry.instance;
  }

  private initializeDefaultChains() {
    // Ethereum Sepolia Testnet
    this.registerChain({
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
      proofApiUrl:
        'https://api-gateway.polygon.technology/api/v3/proof/testnet/',
      isTestnet: true,
    });

    // Polygon Cardona Testnet
    this.registerChain({
      chainId: 2442,
      networkId: 1,
      name: 'Polygon Cardona',
      rpcUrl: 'https://rpc.cardona.zkevm-rpc.com',
      nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
      blockExplorer: {
        name: 'Cardona PolygonScan',
        url: 'https://cardona-zkevm.polygonscan.com',
      },
      bridgeAddress: '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582',
      proofApiUrl:
        'https://api-gateway.polygon.technology/api/v3/proof/testnet/',
      isTestnet: true,
    });
  }

  /**
   * Register a new chain
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
   * Get chain configuration by network ID
   */
  getChainByNetworkId(networkId: number): ChainConfig {
    const chain = Array.from(this.chains.values()).find(
      (chain) => chain.networkId === networkId
    );
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
