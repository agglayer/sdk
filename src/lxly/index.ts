/**
 * LXLY Submodule
 *
 * ERC20 token operations and bridge functionality
 */

import { chainRegistry } from '../chains/registry';
import { ERC20 } from './tokens/erc20';
import { Bridge } from './bridge/bridge';
import { createPublicClient, http, type Address } from 'viem';
import { ValidationUtils } from './utils';

export interface LxlyConfig {
  defaultNetwork?: number;
}

export { ERC20 } from './tokens/erc20';
export { Bridge } from './bridge/bridge';
export { BridgeUtil } from './bridge/util';

export class LxlyClient {
  private config: LxlyConfig;
  private defaultNetwork: number;

  constructor(config: LxlyConfig) {
    this.config = config;
    this.defaultNetwork = this.config.defaultNetwork || 11155111; // Default to Sepolia
  }

  /**
   * Get network configuration from chain registry
   * @param networkId - The network ID (chain ID)
   * @returns Chain configuration
   */
  getNetwork(networkId: number) {
    return chainRegistry.getChain(networkId);
  }

  /**
   * Get all supported networks
   * @returns Array of network IDs
   */
  getSupportedNetworks(): number[] {
    return chainRegistry.getSupportedChainIds();
  }

  /**
   * Get default network ID
   * @returns Default network ID
   */
  getDefaultNetwork(): number {
    return this.defaultNetwork;
  }

  /**
   * Create an ERC20 instance for a specific token on a specific network
   * @param tokenAddress - The ERC20 token contract address
   * @param networkId - The network ID (optional, uses default if not provided)
   * @returns ERC20 instance
   */
  erc20(tokenAddress: string, networkId?: number): ERC20 {
    const network = this.getNetwork(networkId || this.defaultNetwork);

    return new ERC20({
      tokenAddress,
      rpcUrl: network.rpcUrl,
      chainId: network.chainId,
    });
  }

  /**
   * Get native token balance in wei
   * @param address - The address to check balance for
   * @param networkId - The network ID (optional, uses default if not provided)
   * @returns Native token balance as string
   */
  async getNativeBalance(address: string, networkId?: number): Promise<string> {
    ValidationUtils.validateAddress(address, 'Address');
    const network = this.getNetwork(networkId || this.defaultNetwork);

    const client = createPublicClient({
      chain: {
        id: network.chainId,
        name: network.name,
        nativeCurrency: network.nativeCurrency,
        rpcUrls: {
          default: { http: [network.rpcUrl] },
          public: { http: [network.rpcUrl] },
        },
      },
      transport: http(network.rpcUrl),
    });

    const balance = await client.getBalance({ address: address as Address });
    return balance.toString();
  }

  /**
   * Create a Bridge instance for a specific network
   * @param bridgeAddress - The bridge contract address
   * @param networkId - The network ID (optional, uses default if not provided)
   * @returns Bridge instance
   */
  bridge(bridgeAddress: string, networkId?: number): Bridge {
    const network = this.getNetwork(networkId || this.defaultNetwork);

    return new Bridge({
      bridgeAddress,
      rpcUrl: network.rpcUrl,
      chainId: network.chainId,
    });
  }
}
