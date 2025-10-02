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
  BuildClaimTransactionResponse,
  TokenMappingQueryParams,
  TokenMappingResponse,
} from '../../types/core';

export class ArcApiService {
  private httpClient: HttpClient;

  constructor({ baseUrl, timeout }: { baseUrl: string; timeout: number }) {
    this.httpClient = new HttpClient({ baseUrl, timeout });
  }

  // responsible for both chains metadata and tokens
  // supports limit/offset based pagination
  async chains({
    withSupportedTokens = false,
    limit = 10,
    offset,
    chainIds,
  }: ChainsQueryParams = {}): Promise<Response<ApiResponse<ChainsResponse>>> {
    return this.httpClient.get('/metadata/chains', {
      withSupportedTokens,
      limit,
      offset,
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
      '/routes/build-transaction',
      builtTransactionRequestBody
    );
  }

  async buildClaimTransaction(
    sourceNetworkId: number,
    depositCount: number
  ): Promise<Response<ApiResponse<BuildClaimTransactionResponse>>> {
    return this.httpClient.post('/routes/build-transaction-for-claim', {
      sourceNetworkId,
      depositCount,
    });
  }

  // supports cursor based pagination only
  async transactions(
    transactionsRequestQueryParams: TransactionsRequestQueryParams
  ): Promise<Response<ApiResponse<TransactionsResponse>>> {
    return this.httpClient.get('/transactions', {
      transactionsRequestQueryParams,
    });
  }

  async tokenMappings(
    tokenMappingQueryParams: TokenMappingQueryParams
  ): Promise<Response<ApiResponse<TokenMappingResponse>>> {
    const { tokenAddress } = tokenMappingQueryParams;
    return this.httpClient.get(`/token-mappings/${tokenAddress}`);
  }
}
