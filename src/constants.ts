/**
 * SDK Constants
 */

// network ids
export const NETWORKS = {
  SEPOLIA: 11155111,
  CARDONA: 2442,
} as const;

export const DEFAULT_NETWORK = NETWORKS.SEPOLIA;

// todo: add logic to handle max limit
export const MAX_CHAINS_PER_PAGE = 100;
export const DEFAULT_CHAINS_PER_PAGE = 100;

export const MAX_CHAINS_WITH_TOKENS_PER_PAGE = 5;
export const DEFAULT_CHAINS_WITH_TOKENS_PER_PAGE = 1;

export const MAX_TRANSACTIONS_PER_PAGE = 100;
export const DEFAULT_TRANSACTIONS_PER_PAGE = 20;
