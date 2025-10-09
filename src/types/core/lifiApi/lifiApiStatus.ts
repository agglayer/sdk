/**
 * LiFi API Status Types
 *
 * Defines the request and response types for the LiFi status endpoint.
 */

export interface LiFiToken {
  readonly address: string;
  readonly chainId: number;
  readonly symbol: string;
  readonly decimals: number;
  readonly name: string;
  readonly coinKey: string;
  readonly logoURI: string;
  readonly priceUSD: string;
}

export interface LiFiStep {
  readonly tool: string;
  readonly toolDetails: {
    readonly key: string;
    readonly name: string;
    readonly logoURI: string;
  };
  readonly fromAmount: string;
  readonly fromToken: LiFiToken;
  readonly toToken: LiFiToken;
  readonly toAmount: string;
  readonly bridgedAmount: string;
}

export interface LiFiTransaction {
  readonly txHash: string;
  readonly txLink: string;
  readonly amount: string;
  readonly token: LiFiToken;
  readonly chainId: number;
  readonly gasPrice: string;
  readonly gasUsed: string;
  readonly gasToken: LiFiToken;
  readonly gasAmount: string;
  readonly gasAmountUSD: string;
  readonly amountUSD: string;
  readonly value: string;
  readonly includedSteps: LiFiStep[];
  readonly timestamp: number;
}

export interface LiFiFeeCost {
  readonly name: string;
  readonly description: string;
  readonly percentage: string;
  readonly token: LiFiToken;
  readonly amount: string;
  readonly amountUSD: string;
  readonly included: boolean;
}

export interface LiFiMetadata {
  readonly integrator: string;
  readonly [key: string]: unknown;
}

export type LiFiTransferStatus =
  | 'NOT_FOUND'
  | 'INVALID'
  | 'PENDING'
  | 'DONE'
  | 'FAILED';

export type LiFiTransferSubstatus =
  | 'WAIT_SOURCE_CONFIRMATIONS'
  | 'WAIT_DESTINATION_TRANSACTION'
  | 'BRIDGE_NOT_AVAILABLE'
  | 'CHAIN_NOT_AVAILABLE'
  | 'REFUND_IN_PROGRESS'
  | 'UNKNOWN_ERROR'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'REFUNDED';

export type LiFiBridge =
  | 'hop'
  | 'cbridge'
  | 'celercircle'
  | 'optimism'
  | 'polygon'
  | 'arbitrum'
  | 'avalanche'
  | 'across'
  | 'gnosis'
  | 'omni'
  | 'relay'
  | 'celerim'
  | 'symbiosis'
  | 'thorswap'
  | 'squid'
  | 'allbridge'
  | 'mayan'
  | 'debridge'
  | 'chainflip';

export interface LiFiStatusRequestParams {
  readonly txHash: string;
  readonly bridge?: LiFiBridge;
  readonly fromChain?: string;
  readonly toChain?: string;
}

export interface LiFiStatusResponse {
  readonly transactionId: string;
  readonly sending: LiFiTransaction;
  readonly receiving?: LiFiTransaction;
  readonly feeCosts: LiFiFeeCost[];
  readonly lifiExplorerLink: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly tool: string;
  readonly status: LiFiTransferStatus;
  readonly substatus?: LiFiTransferSubstatus;
  readonly substatusMessage?: string;
  readonly metadata: LiFiMetadata;
  readonly bridgeExplorerLink?: string;
}
