import type { SDKConfig } from '../types';

export class CoreClient {
  private config: SDKConfig;

  constructor(config: SDKConfig) {
    this.config = config;

    this.validateConfig();
  }

  /**
   * Validate config
   */
  private validateConfig(): void {}

  /**
   * Get all chains from AggLayer API
   */
  async getAllChains() {}

  /**
   * Get chain metadata by id from AggLayer API
   */
  async getChainMetadataById() {}

  /**
   * Get all tokens from AggLayer API
   */
  async getTokens() {}

  /**
   * Get all routes from AggLayer API
   */
  async getRoutes() {}

  /**
   * Build transaction from a step object
   */
  async buildTransaction() {}

  /**
   * Get all transactions via web sockets
   */
  async getTransactions() {}
}
