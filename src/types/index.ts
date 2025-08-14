/**
 * Agglayer SDK Types
 *
 * This file serves as the central export point for all SDK types.
 * Import types from this file for the best developer experience.
 */

// Import types for internal use
import { SDKConfig } from './config';
import { AgglayerAPI } from './agglayerApi';

// Core SDK Types
export interface AgglayerSDK {
  config: SDKConfig;
  agglayerApi?: AgglayerAPI;
  // ...other modules like routes, utils, etc.
}

// Re-export all types from their respective modules
export * from './config';
export * from './agglayerApi';
