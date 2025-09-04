/**
 * Approval Utilities
 *
 * Utility functions for checking and calculating token approvals
 */

export class ApprovalUtils {
  /**
   * Convert value to BigInt
   */
  private static toBigInt(value: string | number | bigint): bigint {
    return BigInt(value.toString());
  }

  /**
   * Check if approval is needed
   */
  static isApprovalNeeded(
    allowance: string | number | bigint,
    amount: string | number | bigint
  ): boolean {
    return this.toBigInt(allowance) < this.toBigInt(amount);
  }

  /**
   * Get approval amount needed in wei
   */
  static getApprovalAmountNeeded(
    allowance: string | number | bigint,
    amount: string | number | bigint
  ): string {
    const required = this.toBigInt(amount);
    const current = this.toBigInt(allowance);

    if (current >= required) {
      return '0';
    }

    return (required - current).toString();
  }

  /**
   * Calculate the remaining allowance after a transfer in wei
   */
  static getRemainingAllowance(
    allowance: string | number | bigint,
    amount: string | number | bigint
  ): string {
    const currentAllowance = this.toBigInt(allowance);
    const transferAmount = this.toBigInt(amount);

    if (currentAllowance < transferAmount) {
      return '0';
    }

    return (currentAllowance - transferAmount).toString();
  }

  /**
   * Check if approval should be set to max (infinite approval)
   */
  static shouldSetMaxApproval(
    _allowance: string | number | bigint,
    amount: string | number | bigint
  ): boolean {
    const maxUint256 = BigInt(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    );
    const amountBigInt = this.toBigInt(amount);

    return amountBigInt > (maxUint256 * BigInt(90)) / BigInt(100);
  }
}
