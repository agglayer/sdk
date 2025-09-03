/**
 * Arc API Service
 *
 * Service for the Arc API
 */

import { HttpClient, Response } from '../utils/httpClient';
import {
  ApiResponse,
  ChainsQueryParams,
  ChainsResponse,
  RoutesRequestParams,
  RoutesResponse,
  BuildTransactionRequestBody,
  BuildTransactionResponse,
  TransactionsRequestQueryParams,
  TransactionsResponse,
} from '../../types/core';

export class ArcApiService {
  private httpClient: HttpClient;

  constructor({ baseUrl, timeout }: { baseUrl: string; timeout: number }) {
    this.httpClient = new HttpClient({ baseUrl, timeout });
  }

  // responsible for both chains metadata and tokens
  async chains({
    withSupportedTokens = false,
    limit = 20,
    startAfter = 0,
    chainIds,
  }: ChainsQueryParams = {}): Promise<Response<ApiResponse<ChainsResponse>>> {
    return this.httpClient.get('/metadata/chains', {
      withSupportedTokens,
      limit,
      startAfter,
      chainIds,
    });
  }

  async routes(
    routesRequestParams: RoutesRequestParams
  ): Promise<Response<ApiResponse<RoutesResponse>>> {
    return this.httpClient.post('/routes', routesRequestParams);
  }

  async buildTransaction(
    builtTransactionRequestBody: BuildTransactionRequestBody
  ): Promise<Response<ApiResponse<BuildTransactionResponse>>> {
    return this.httpClient.post(
      '/build-transaction',
      builtTransactionRequestBody
    );
  }

  async transactions(
    transactionsRequestQueryParams: TransactionsRequestQueryParams
  ): Promise<Response<ApiResponse<TransactionsResponse>>> {
    return this.httpClient.get('/transactions', {
      transactionsRequestQueryParams,
    });
  }
}
