/**
 * Arc API Response Types
 *
 * Defines the core response structure for all Arc API endpoints.
 * Uses discriminated unions for type-safe error handling.
 */

// Base response structure with discriminated union
export type ApiResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// Success response with generic data type
export interface SuccessResponse<T = unknown> {
  readonly status: 'success';
  readonly data: T;
}

// Comprehensive error response following RFC 7807 Problem Details
export interface ErrorResponse {
  readonly status: 'error';
  readonly message: string;
  readonly name: string;
  readonly code: number;
  readonly details?: Record<string, unknown>;
}
