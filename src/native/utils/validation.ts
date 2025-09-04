/**
 * Validation Utilities
 *
 * Utility functions for validating inputs and addresses
 */

export class ValidationUtils {
  /**
   * Convert value to BigInt safely
   */
  private static toBigInt(value: string | number | bigint): bigint {
    return BigInt(value.toString());
  }

  /**
   * Validate Ethereum address format
   */
  static validateAddress(address: string, name: string = 'Address'): void {
    if (!address || !address.startsWith('0x') || address.length !== 42) {
      throw new Error(`${name} must be a valid 0x-prefixed address`);
    }
  }

  /**
   * Validate amount (must be positive)
   */
  static validateAmount(
    amount: string | number | bigint,
    name: string = 'Amount'
  ): void {
    const amountStr = amount.toString();
    if (!amountStr || amountStr === '0' || this.toBigInt(amount) <= 0n) {
      throw new Error(`${name} must be a positive value`);
    }
  }

  /**
   * Check if address is valid without throwing
   */
  static isValidAddress(address: string): boolean {
    return (
      Boolean(address) && address.startsWith('0x') && address.length === 42
    );
  }

  /**
   * Check if amount is valid without throwing
   */
  static isValidAmount(amount: string | number | bigint): boolean {
    try {
      const amountStr = amount.toString();
      return (
        Boolean(amountStr) && amountStr !== '0' && this.toBigInt(amount) > 0n
      );
    } catch {
      return false;
    }
  }

  /**
   * Validate chain ID
   */
  static validateChainId(chainId: number): void {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error('Chain ID must be a positive integer');
    }
  }

  /**
   * Validate RPC URL
   */
  static validateRpcUrl(rpcUrl: string): void {
    if (!rpcUrl || !rpcUrl.startsWith('http')) {
      throw new Error('RPC URL must be a valid HTTP/HTTPS URL');
    }
  }
}
