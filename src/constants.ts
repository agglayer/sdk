/**
 * SDK Constants
 */

/**
 * SDK mode = CORE
 *
 */
// if changing these, also change in README.md
export const ARC_API_BASE_URL = 'https://arc-api.polygon.technology';
export const ARC_API_DEFAULT_TIMEOUT = 30000; // in ms

// LiFi API constants
export const LIFI_API_BASE_URL = 'https://li.quest';
export const LIFI_API_DEFAULT_TIMEOUT = 5000; // in ms

// todo: add logic to handle max limit
export const MAX_CHAINS_PER_PAGE = 100;
export const DEFAULT_CHAINS_PER_PAGE = 100;

export const MAX_CHAINS_WITH_TOKENS_PER_PAGE = 5;
export const DEFAULT_CHAINS_WITH_TOKENS_PER_PAGE = 1;

export const MAX_TRANSACTIONS_PER_PAGE = 100;
export const DEFAULT_TRANSACTIONS_PER_PAGE = 20;

/**
 * SDK mode = NATIVE
 */

// network ids
export const NETWORKS = {
  ETHEREUM: 1,
  KATANA: 747474,
} as const;

export const DEFAULT_NETWORK = NETWORKS.ETHEREUM;

// Zero address for native ETH
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
