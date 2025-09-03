/**
 * Core Module
 *
 * Primary interface for users
 */

import type {
  CoreConfig,
  RoutesRequestParams,
  RoutesResponse,
  TransactionsRequestQueryParams,
  TransactionsResponse,
  ChainsResponse,
  BuildTransactionRequestBody,
  BuildTransactionResponse,
} from '@/types';
import { ArcApiService } from './services/arcApi';

export class CoreClient {
  private config: CoreConfig;
  private arcApiService: ArcApiService;

  constructor(config: CoreConfig) {
    this.config = config;

    if (!this.config) {
      throw new Error('Config is required');
    }

    if (!this.config.apiBaseUrl) {
      throw new Error('API base URL is required');
    }

    const { apiBaseUrl, apiTimeout } = this.config;

    this.arcApiService = new ArcApiService({
      baseUrl: apiBaseUrl,
      timeout: apiTimeout ?? 30000,
    });
  }

  /**
   * Get all chains metadata from AggLayer API
   */
  async getAllChains(): Promise<ChainsResponse> {
    const response = await this.arcApiService.chains();
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }

  /**
   * Get chain metadata by id from AggLayer API
   * @param ids - the ids of the chains to get metadata for
   */
  async getChainMetadataByChainIds(ids: number[]): Promise<ChainsResponse> {
    const response = await this.arcApiService.chains({ chainIds: ids });
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }

  /**
   * Get all tokens from AggLayer API
   */
  async getTokens(): Promise<ChainsResponse> {
    const response = await this.arcApiService.chains({
      withSupportedTokens: true,
    });
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }

  /**
   * Get chain data and tokens by AggLayer API
   * @param ids - the ids of the chains to get data and tokens for
   */
  async getChainDataAndTokensByChainIds(
    ids: number[]
  ): Promise<ChainsResponse> {
    const response = await this.arcApiService.chains({
      chainIds: ids,
      withSupportedTokens: true,
    });
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }

  /**
   * Get all routes from AggLayer API
   */
  async getRoutes(
    routesRequestParams: RoutesRequestParams
  ): Promise<RoutesResponse> {
    const response = await this.arcApiService.routes(routesRequestParams);
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }

  /**
   * Build transaction from a step object
   */
  async buildTransaction(
    builtTransactionRequestBody: BuildTransactionRequestBody
  ): Promise<BuildTransactionResponse> {
    const response = await this.arcApiService.buildTransaction(
      builtTransactionRequestBody
    );
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }

  /**
   * Get all transactions via web sockets
   */
  async getTransactions(
    transactionsRequestQueryParams: TransactionsRequestQueryParams
  ): Promise<TransactionsResponse> {
    const response = await this.arcApiService.transactions(
      transactionsRequestQueryParams
    );
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.message);
  }
}
