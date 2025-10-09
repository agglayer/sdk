/**
 * LiFi API Service
 *
 * Service for the LiFi status API endpoint.
 * Provides functionality to check the status of cross-chain transfers.
 */

import { HttpClient, Response } from '../utils/httpClient';
import type { LiFiStatusRequestParams, LiFiStatusResponse } from '@/types';

export class LiFiApiService {
  private httpClient: HttpClient;

  constructor({ baseUrl, timeout }: { baseUrl: string; timeout: number }) {
    this.httpClient = new HttpClient({ baseUrl, timeout });
  }

  /**
   * Check the status of a cross-chain transfer
   *
   * @param params - Status request parameters
   * @param params.txHash - The transaction hash on the sending chain, destination chain or lifi step id
   * @param params.bridge - Optional: The bridging tool used for the transfer
   * @param params.fromChain - Optional: The sending chain (chain id or chain key)
   * @param params.toChain - Optional: The receiving chain (chain id or chain key)
   * @returns Promise containing the transfer status response
   */
  async getStatus(
    params: LiFiStatusRequestParams
  ): Promise<Response<LiFiStatusResponse>> {
    const { txHash, bridge, fromChain, toChain } = params;

    const queryParams: Record<string, string> = {
      txHash,
    };

    if (bridge) {
      queryParams['bridge'] = bridge;
    }

    if (fromChain) {
      queryParams['fromChain'] = fromChain;
    }

    if (toChain) {
      queryParams['toChain'] = toChain;
    }

    return this.httpClient.get('/v1/status', queryParams);
  }
}
