/**
 * Bridge Types
 *
 * Types related to bridge operations
 */

export interface BridgeAssetParams {
  destinationNetwork: number;
  destinationAddress: string;
  amount: string;
  token: string;
  forceUpdateGlobalExitRoot: boolean;
  permitData?: string;
}

export interface BridgeOptions {
  forceUpdateGlobalExitRoot?: boolean;
  permitData?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface ClaimAssetParams {
  smtProofLocalExitRoot: readonly `0x${string}`[];
  smtProofRollupExitRoot: readonly `0x${string}`[];
  globalIndex: bigint;
  mainnetExitRoot: `0x${string}`;
  rollupExitRoot: `0x${string}`;
  originNetwork: number;
  originTokenAddress: string;
  destinationNetwork: number;
  destinationAddress: string;
  amount: bigint;
  metadata: `0x${string}`;
}

export interface IsClaimedParams {
  leafIndex: number;
  sourceBridgeNetwork: number;
}

export interface WrappedTokenParams {
  originNetwork: number;
  originTokenAddress: string;
}

export interface BridgeMessageParams {
  destinationNetwork: number;
  destinationAddress: string;
  forceUpdateGlobalExitRoot: boolean;
  permitData?: string;
}

export interface ClaimMessageParams {
  smtProofLocalExitRoot: readonly `0x${string}`[];
  smtProofRollupExitRoot: readonly `0x${string}`[];
  globalIndex: bigint;
  mainnetExitRoot: `0x${string}`;
  rollupExitRoot: `0x${string}`;
  originNetwork: number;
  originTokenAddress: string;
  destinationNetwork: number;
  destinationAddress: string;
  amount: bigint;
  metadata: `0x${string}`;
}

export interface PrecalculatedWrapperParams {
  originNetwork: number;
  originTokenAddress: string;
}

export interface OriginTokenInfoParams {
  wrappedToken: string;
}
