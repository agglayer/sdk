/**
 * API Error Class
 *
 * Custom error class to preserve API error details
 */

import type { ErrorResponse } from '../../types/core/_arcApiBase';

export class ApiError extends Error {
  public readonly code: number;
  public override readonly name: string;
  public readonly details?: Record<string, unknown> | undefined;

  constructor(errorResponse: ErrorResponse) {
    super(errorResponse.message);

    this.name = errorResponse.name;
    this.code = errorResponse.code;
    this.details = errorResponse.details;

    // Maintain proper stack trace (if available)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }

  /**
   * Create API error from error response
   */
  static fromErrorResponse(errorResponse: ErrorResponse): ApiError {
    return new ApiError(errorResponse);
  }

  /**
   * Create fallback error when API completely fails
   */
  static createFallbackError(
    originalError: Error,
    operation: string
  ): ApiError {
    return new ApiError({
      status: 'error',
      message: `${operation} failed: ${originalError.message}`,
      name: 'ApiConnectionError',
      code: 500,
      details: {
        originalError: originalError.message,
        operation,
      },
    });
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
    };
  }
}
