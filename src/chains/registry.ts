/**
 * Chain Registry
 *
 * Centralized chain configuration management
 */

import { type Chain } from 'viem';

export interface ChainConfig {
  id: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorer?: {
    name: string;
    url: string;
  };
  isTestnet?: boolean;
  isLocal?: boolean;
}

export interface CustomChainConfig extends ChainConfig {
  // Additional properties for custom chains
  isTestnet?: boolean;
  isLocal?: boolean;
}

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
    // Ethereum Mainnet
    this.registerChain({
      id: 1,
      name: 'Ethereum Mainnet',
      rpcUrl: 'https://eth.llamarpc.com',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorer: { name: 'Etherscan', url: 'https://etherscan.io' },
    });

    // Polygon Mainnet
    this.registerChain({
      id: 137,
      name: 'Polygon Mainnet',
      rpcUrl: 'https://polygon-rpc.com',
      nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      blockExplorer: { name: 'PolygonScan', url: 'https://polygonscan.com' },
    });

    // Ethereum Sepolia Testnet
    this.registerChain({
      id: 11155111,
      name: 'Ethereum Sepolia',
      rpcUrl: 'https://rpc.sepolia.org',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      blockExplorer: {
        name: 'Sepolia Etherscan',
        url: 'https://sepolia.etherscan.io',
      },
      isTestnet: true,
    });

    // Polygon Amoy Testnet
    this.registerChain({
      id: 80002,
      name: 'Polygon Amoy',
      rpcUrl: 'https://rpc-amoy.polygon.technology',
      nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      blockExplorer: {
        name: 'Amoy PolygonScan',
        url: 'https://www.oklink.com/amoy',
      },
      isTestnet: true,
    });

    // Local development chains
    // todo: remove these chains before publishing
    this.registerChain({
      id: 31337,
      name: 'Hardhat Local',
      rpcUrl: 'http://localhost:8545',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      isLocal: true,
    });

    this.registerChain({
      id: 1337,
      name: 'Ganache Local',
      rpcUrl: 'http://localhost:7545',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      isLocal: true,
    });
  }

  /**
   * Register a new chain
   */
  registerChain(config: ChainConfig): void {
    this.chains.set(config.id, config);

    // Create viem chain object
    const viemChain: Chain = {
      id: config.id,
      name: config.name,
      nativeCurrency: config.nativeCurrency,
      rpcUrls: {
        default: { http: [config.rpcUrl] },
      },
    };

    this.viemChains.set(config.id, viemChain);
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
