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
  PaginatedTransactionsResponse,
  ChainsResponse,
  Route,
  BuildClaimTransactionRequestParam,
  TokenMappingQueryParams,
  TokenMappingResponse,
  TokenMetadataRequestParam,
  TokenMetadataResponse,
} from '@/types';
import { ArcApiService } from './services/arcApi';
import { UnsignedTransaction } from 'types/core/_arcApiUnsignedTransaction';
import { ApiError } from './utils/apiError';
import {
  ARC_API_BASE_URL,
  ARC_API_DEFAULT_TIMEOUT,
  DEFAULT_CHAINS_PER_PAGE,
  DEFAULT_CHAINS_WITH_TOKENS_PER_PAGE,
  MAX_TRANSACTIONS_PER_PAGE,
} from '../constants';

export class CoreClient {
  private config: CoreConfig;
  private arcApiService: ArcApiService;

  constructor(config?: CoreConfig) {
    // build config first
    this.config = {
      ...config,
      apiBaseUrl: config?.apiBaseUrl || ARC_API_BASE_URL,
      apiTimeout: config?.apiTimeout || ARC_API_DEFAULT_TIMEOUT,
    };

    const { apiBaseUrl, apiTimeout } = this.config;

    this.arcApiService = new ArcApiService({
      baseUrl: apiBaseUrl || ARC_API_BASE_URL,
      timeout: apiTimeout || ARC_API_DEFAULT_TIMEOUT,
    });
  }

  /**
   * Generic pagination helper for chains API calls (limit and offset based pagination)
   * Handles automatic pagination to fetch all available data
   * @param params - Parameters for the chains API call
   * @param pageSize - Number of items per page (defaults to DEFAULT_CHAINS_PER_PAGE)
   */
  private async getAllChainsPaginated(
    params: {
      chainIds?: number[];
      withSupportedTokens?: boolean;
      limit?: number;
      offset?: number;
    },
    pageSize: number = DEFAULT_CHAINS_PER_PAGE
  ): Promise<ChainsResponse> {
    try {
      // First call to get initial data and check total count
      const firstResponse = await this.arcApiService.chains({
        ...params,
        limit: pageSize,
      });

      if (firstResponse.data.status !== 'success') {
        throw ApiError.fromErrorResponse(firstResponse.data);
      }

      const firstPageData = firstResponse.data.data;
      const pagination = firstResponse.data.pagination;

      // The API returns chains directly as an array in the data field
      const firstPageChains = Array.isArray(firstPageData) ? firstPageData : [];

      // If no pagination info or total is within first page, return first page data
      if (!pagination?.total || pagination.total <= pageSize) {
        return {
          chains: firstPageChains,
        };
      }

      // Calculate how many additional pages we need to fetch
      const totalPages = Math.ceil(pagination.total / pageSize);
      const remainingPages = totalPages - 1; // We already have the first page

      if (remainingPages === 0) {
        return {
          chains: firstPageChains,
        };
      }

      // Create array of promises for remaining pages (parallel calls)
      const remainingPagePromises = Array.from(
        { length: remainingPages },
        (_, index) => {
          const offset = (index + 1) * pageSize;
          return this.arcApiService.chains({
            ...params,
            limit: pageSize,
            offset,
          });
        }
      );

      // Execute all remaining page calls in parallel
      const remainingResponses = await Promise.all(remainingPagePromises);

      // Check for errors in any of the responses
      for (const response of remainingResponses) {
        if (response.data.status !== 'success') {
          throw ApiError.fromErrorResponse(response.data);
        }
      }

      // Combine all chain data from all pages
      const allChains = [
        ...firstPageChains,
        ...remainingResponses.flatMap((response) => {
          if (response.data.status === 'success') {
            return Array.isArray(response.data.data) ? response.data.data : [];
          }
          return [];
        }),
      ];

      // Return combined data
      return {
        chains: allChains,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(error as Error, 'Get chains metadata');
    }
  }

  /**
   * Get all chains metadata from AggLayer API
   * Handles pagination automatically to fetch all available chains
   */
  async getAllChains(): Promise<ChainsResponse> {
    return this.getAllChainsPaginated({});
  }

  /**
   * Get chain metadata by id from AggLayer API
   * Handles pagination automatically to fetch all available chain metadata
   * @param ids - the ids of the chains to get metadata for
   */
  async getChainMetadataByChainIds(ids: number[]): Promise<ChainsResponse> {
    return this.getAllChainsPaginated({ chainIds: ids });
  }

  /**
   * Get all tokens from AggLayer API
   *
   * Developer Note: This method is not recommended to use frequently or from frontend.
   * As it can be very slow and resource intensive.
   * It is recommended to use getChainDataAndTokensByChainIds instead.
   */
  async getAllTokens(): Promise<ChainsResponse> {
    return this.getAllChainsPaginated(
      { withSupportedTokens: true },
      DEFAULT_CHAINS_WITH_TOKENS_PER_PAGE
    );
  }

  /**
   * Get chain data and tokens by AggLayer API
   * @param ids - the ids of the chains to get data and tokens for
   */
  async getChainDataAndTokensByChainIds(
    ids: number[]
  ): Promise<ChainsResponse> {
    return this.getAllChainsPaginated({
      chainIds: ids,
      withSupportedTokens: true,
    });
  }

  /**
   * Get token metadata by token address from ARC API
   * @param tokenMetadataRequestParam - Object containing the token address
   */
  async getTokenMetadata(
    tokenMetadataRequestParam: TokenMetadataRequestParam
  ): Promise<TokenMetadataResponse> {
    try {
      const response = await this.arcApiService.tokenMetadata(
        tokenMetadataRequestParam
      );
      if (response.data.status === 'success') {
        return response.data.data;
      }
      throw ApiError.fromErrorResponse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(error as Error, 'Get token metadata');
    }
  }

  /**
   * Get all routes from AggLayer API
   */
  async getRoutes(
    routesRequestParams: RoutesRequestParams
  ): Promise<RoutesResponse> {
    try {
      const response = await this.arcApiService.routes(routesRequestParams);
      if (response.data.status === 'success') {
        return response.data.data;
      }
      throw ApiError.fromErrorResponse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(error as Error, 'Get routes');
    }
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
      throw ApiError.createFallbackError(
        new Error('Route has no steps to build transaction from'),
        'Get unsigned transaction'
      );
    }

    try {
      const response = await this.arcApiService.buildTransaction(
        route.steps[0]
      );
      if (response.data.status === 'success') {
        return response.data.data;
      }
      throw ApiError.fromErrorResponse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(
        error as Error,
        'Get unsigned transaction'
      );
    }
  }

  /**
   * Get calldata for claim step
   * Needs to be called separately as claim step is not part of route.
   *
   * @developer Note: Do not misinterpret network ID as chain ID.
   *
   * @param sourceNetworkId - The source network ID where the transfer was initiated.
   * @param depositCount - The deposit count associated with the transfer.
   */
  async getClaimUnsignedTransaction(
    buildClaimTxParams: BuildClaimTransactionRequestParam
  ): Promise<UnsignedTransaction> {
    try {
      const response = await this.arcApiService.buildClaimTransaction(
        buildClaimTxParams.sourceNetworkId,
        buildClaimTxParams.depositCount
      );
      if (response.data.status === 'success') {
        return response.data.data;
      }
      throw ApiError.fromErrorResponse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(
        error as Error,
        'Get claim unsigned transaction'
      );
    }
  }

  /**
   * Get all transactions with pagination information
   * @param transactionsRequestQueryParams - Parameters for the transactions API call
   */
  async getTransactions(
    transactionsRequestQueryParams: TransactionsRequestQueryParams
  ): Promise<PaginatedTransactionsResponse> {
    // validate limit
    if (
      transactionsRequestQueryParams.limit &&
      transactionsRequestQueryParams.limit > MAX_TRANSACTIONS_PER_PAGE
    ) {
      throw ApiError.createFallbackError(
        new Error(`Limit cannot be greater than ${MAX_TRANSACTIONS_PER_PAGE}`),
        'Get transactions'
      );
    }

    try {
      const response = await this.arcApiService.transactions(
        transactionsRequestQueryParams
      );
      if (response.data.status === 'success') {
        return {
          transactions: response.data.data,
          ...(response.data.pagination && {
            pagination: response.data.pagination,
          }),
        };
      }
      throw ApiError.fromErrorResponse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(error as Error, 'Get transactions');
    }
  }

  /**
   * Get token mappings by token address
   * @developer Note: Do not misinterpret network ID as chain ID.
   *
   * @param tokenAddress
   */
  async getTokenMappings(
    tokenMappingQueryParams: TokenMappingQueryParams
  ): Promise<TokenMappingResponse> {
    try {
      const response = await this.arcApiService.tokenMappings(
        tokenMappingQueryParams
      );
      if (response.data.status === 'success') {
        return response.data.data;
      }
      throw ApiError.fromErrorResponse(response.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw ApiError.createFallbackError(
        error as Error,
        'Get custom token mappings'
      );
    }
  }
}
