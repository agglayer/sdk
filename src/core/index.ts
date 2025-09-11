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
  Route,
} from '@/types';
import { ArcApiService } from './services/arcApi';
import { UnsignedTransaction } from 'types/core/_arcApiUnsignedTransaction';

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
    // todo: user should get all data, handle pagination here, once backend adds pagination
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
    // todo: user should get all data, handle pagination here, once backend adds pagination
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
   * Get calldata from a route
   * If route has transactionRequest field, return it directly as calldata
   * Otherwise, call buildTransaction on route.steps[0] and return that as calldata
   */
  async getUnsignedTransaction(route: Route): Promise<UnsignedTransaction> {
    if (route.transactionRequest) {
      return route.transactionRequest;
    }

    // If no transactionRequest, call buildTransaction on first step
    if (route.steps.length === 0 || !route.steps[0]) {
      throw new Error('Route has no steps to build transaction from');
    }

    const response = await this.arcApiService.buildTransaction(route.steps[0]);
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
