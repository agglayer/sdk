/**
 * Arc API Routes Types
 *
 * Defines the core request and response types for the routes endpoint.
 */

import { TokenInfo, TokenReference } from './_arcApiTokens';
import { UnsignedTransaction } from './_arcApiUnsignedTransaction';

export interface RoutePreferences {
  readonly prioritize?: 'COST' | 'SPEED';
  readonly minAmountToReceive?: string;
  readonly gasEstimate?: string;
  readonly excludeProtocols?: readonly string[];
  readonly includeProtocols?: readonly string[];
}

export interface FeeCost {
  readonly name: string;
  readonly description?: string;
  readonly token: TokenInfo;
  readonly amount: string;
  readonly amountUSD?: string;
  readonly percentage?: string;
  readonly included: boolean;
}

export interface GasCost {
  readonly type: 'SEND' | 'APPROVAL' | 'EXECUTION';
  readonly chainId: number;
  readonly price: string;
  readonly estimate: string;
  readonly limit: string;
  readonly amount: string;
  readonly amountUSD?: string;
  readonly token: TokenReference;
}

export type StepType = 'swap' | 'cross' | 'lifi';

export interface ToolDetails {
  readonly key: string;
  readonly name: string;
  readonly logoURI: string | null;
  readonly webUrl?: string | null;
}

export interface StepAction {
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly fromToken: TokenInfo;
  readonly toToken: TokenInfo;
  readonly fromAddress: string | null;
  readonly toAddress: string | null;
  readonly contractAddress?: string | null;
  readonly callData?: string | null;
  readonly value?: string | null;
  readonly slippage?: number;

  // Enhanced destination chain execution details
  readonly destinationGasConsumption?: string;
  readonly destinationCallData?: string;
  readonly toContractAddress?: string;
  readonly toContractCallData?: string;
  readonly toFallbackAddress?: string;
  readonly callDataGasLimit?: string;
}

export interface StepEstimate {
  readonly tool: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly toAmountMin: string;
  readonly approvalAddress: string | null;
  readonly executionDuration: number | null;
  readonly feeCosts: FeeCost[];
  readonly gasCosts: GasCost[];
  readonly fromAmountUSD?: string | null;
  readonly toAmountUSD?: string | null;
}

export interface Step {
  readonly id: string;
  readonly type: StepType;
  readonly tool: string;
  readonly toolDetails: ToolDetails;
  readonly action: StepAction;
  readonly estimate: StepEstimate;
  readonly includedSteps: Step[] | null;
  readonly relatedSteps: string[] | null;
}

export interface ProviderMetadata {
  readonly lifi?: {
    readonly integrator: string | null;
    readonly transactionRequest?: unknown; // Keep original transaction data
  };
  readonly agglayer?: {
    readonly bridgeAddress: string | null;
  };
  readonly [key: string]: unknown; // Allow for future providers
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | null;

export interface RiskFactors {
  readonly slippageRisk: RiskLevel;
  readonly executionRisk: RiskLevel;
  readonly liquidityRisk: RiskLevel;
}

export interface Route {
  // Universal route identifiers
  readonly id: string; // Route/Quote ID from provider or generated
  readonly provider: string[]; // "LIFI" | "AGGLAYER"

  // Response type identification
  readonly isQuote: boolean; // true for executable quotes, false for route discovery
  readonly quoteValidUntil?: number; // Quote expiration timestamp

  // Route basic information
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly toAmountMin: string;
  readonly fromAmountUSD: string | null;
  readonly toAmountUSD: string | null;

  // Token information
  readonly fromToken: TokenInfo;
  readonly toToken: TokenInfo;

  // Cost and performance metrics
  readonly gasCostUSD: string | null;
  readonly totalCostUSD: string | null; // Gas + fees
  readonly executionDuration: number | null; // in seconds
  readonly slippagePercentage: number | null;

  // Route characteristics
  readonly containsSwitchChain: boolean;
  readonly tags: string[];

  // Fee breakdown
  readonly feeCosts: FeeCost[];

  // Gas cost breakdown
  readonly gasCosts: GasCost[];

  // Execution steps (for routes)
  readonly steps: Step[];

  // Ready-to-execute transaction data (for quotes)
  readonly transactionRequest?: UnsignedTransaction;

  // Provider-specific metadata
  readonly providerMetadata: ProviderMetadata;

  // Risk and validation
  readonly riskFactors: RiskFactors | null;

  // Timestamps
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly estimatedCompletionTime: number | null;
}

export interface RouteStep {
  readonly type: 'swap' | 'bridge' | 'transfer';
  readonly protocol: string;
  readonly fromToken: string;
  readonly toToken: string;
  readonly amount: string;
  readonly estimatedAmountOut: string;
  readonly gasEstimate: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RoutesRequestParams {
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromTokenAddress: string;
  readonly toTokenAddress: string;
  readonly amount: string;
  readonly fromAddress: string;
  readonly toAddress?: string;
  readonly slippage?: number;
  readonly preferences?: RoutePreferences;
}

export type RoutesResponse = readonly Route[];
