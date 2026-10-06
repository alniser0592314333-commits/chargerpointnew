/**
 * Typed Domain & Application Errors
 */

export class DomainError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class AuthorizationError extends DomainError {
  constructor(message: string = 'Access denied') {
    super(message, 'AUTHORIZATION_ERROR');
  }
}

export class BinRequiredError extends DomainError {
  constructor(message: string = 'Valid BIN is required for this sensitive operation') {
    super(message, 'BIN_REQUIRED');
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string = 'Resource not found') {
    super(message, 'NOT_FOUND');
  }
}

export class ConflictError extends DomainError {
  constructor(message: string = 'Optimistic concurrency conflict detected') {
    super(message, 'CONFLICT_ERROR');
  }
}

export class BusinessRuleViolation extends DomainError {
  constructor(message: string) {
    super(message, 'BUSINESS_RULE_VIOLATION');
  }
}

export class FinancialInvariantViolation extends DomainError {
  constructor(message: string) {
    super(message, 'FINANCIAL_INVARIANT_VIOLATION');
  }
}

export class ClosedDayError extends DomainError {
  constructor(message: string = 'Operation not allowed on a closed business day') {
    super(message, 'CLOSED_DAY_ERROR');
  }
}

export class InactiveCustomerError extends DomainError {
  constructor(message: string = 'Customer is deactivated or frozen') {
    super(message, 'INACTIVE_CUSTOMER');
  }
}

export class InsufficientPermissionError extends DomainError {
  constructor(message: string = 'Insufficient permissions for operation') {
    super(message, 'INSUFFICIENT_PERMISSION');
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message: string = 'Command with same ID was already processed with different payload') {
    super(message, 'IDEMPOTENCY_CONFLICT');
  }
}

export class SnapshotIntegrityError extends DomainError {
  constructor(message: string = 'Snapshot integrity validation failed: checksum mismatch or corrupted data') {
    super(message, 'SNAPSHOT_INTEGRITY_ERROR');
  }
}

export class SnapshotFormatError extends DomainError {
  constructor(message: string = 'Snapshot schema or format is incompatible') {
    super(message, 'SNAPSHOT_FORMAT_ERROR');
  }
}

export class OrderNumberReservationExhaustedError extends DomainError {
  constructor(message: string = 'Order number reservation exhausted. Connectivity required to obtain more order numbers.') {
    super(message, 'ORDER_NUMBER_RESERVATION_EXHAUSTED');
  }
}

export function presentError(error: any): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) return String(error.message);
  return JSON.stringify(error);
}

