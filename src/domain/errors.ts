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


/**
 * Converts low-level/domain failures into truthful user-facing messages.
 * Technical SQL/RPC details remain available to diagnostics, but are never
 * presented as a misleading generic validation message.
 */
export function presentError(error: unknown, locale: 'ar' | 'en' = 'ar'): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.toLowerCase();
  const ar = locale === 'ar';

  if (text.includes('supabase_not_configured')) return ar ? 'الاتصال بقاعدة البيانات غير مُهيأ. لا يمكن تنفيذ العملية السحابية قبل ضبط إعدادات Supabase.' : 'The database connection is not configured. Configure Supabase before performing cloud operations.';
  if (text.includes('auth_required') || text.includes('authentication required') || text.includes('jwt')) return ar ? 'انتهت جلسة الدخول أو لم تعد صالحة. سجّل الدخول من جديد.' : 'Your session is missing or expired. Please sign in again.';
  if (text.includes('forbidden') || text.includes('lacks required permission') || text.includes('insufficient permission') || text.includes('p4003')) return ar ? 'ليس لديك الصلاحية المطلوبة لتنفيذ هذه العملية.' : 'You do not have permission to perform this operation.';
  if (text.includes('invalid bin') || text.includes('p0003') || text.includes('bin_invalid')) return ar ? 'رمز BIN غير صحيح أو غير مصرح بهذه العملية.' : 'The BIN is invalid or this operation is not authorized.';
  if (text.includes('p4002') || text.includes('suspended or inactive')) return ar ? 'حساب المسؤول موقوف أو غير نشط. لا يمكن تنفيذ العملية.' : 'The administrator account is suspended or inactive.';
  if (text.includes('not found') || text.includes('p0404')) return ar ? 'السجل المطلوب غير موجود، وربما حُذف أو لم تتم مزامنته بعد.' : 'The requested record was not found; it may have been deleted or not synchronized yet.';
  if (text.includes('debt limit') || text.includes('p0429')) return ar ? 'العملية تتجاوز حد الدين المسموح لهذا العميل.' : 'The operation would exceed this customer’s debt limit.';
  if (text.includes('payment amount') || text.includes('invalid amount') || text.includes('p0422')) return ar ? 'المبلغ غير صالح. يجب إدخال مبلغ موجب وبصيغة مالية صحيحة.' : 'The amount is invalid. Enter a positive valid monetary amount.';
  if (text.includes('invalid order status transition') || text.includes('invalid operational transition') || text.includes('p0409')) return ar ? 'العملية غير مسموحة لأن حالة السجل الحالية لا تسمح بهذا الانتقال.' : 'This operation is not allowed from the record’s current state.';
  if (text.includes('version conflict') || text.includes('optimistic concurrency') || text.includes('conflict')) return ar ? 'البيانات تغيّرت على جهاز أو جلسة أخرى. حدّث البيانات ثم أعد المحاولة.' : 'The data changed elsewhere. Refresh and try again.';
  if (text.includes('foreign key') || text.includes('constraint') || text.includes('23503') || text.includes('23505')) return ar ? 'لا يمكن حفظ البيانات بسبب تعارض أو ارتباط بسجل آخر. صحّح البيانات ثم أعد المحاولة.' : 'The data conflicts with another record or database constraint.';
  if (text.includes('network') || text.includes('failed to fetch') || text.includes('timeout') || text.includes('econnrefused')) return ar ? 'تعذر الاتصال بالخادم حاليًا. لم تُعتبر العملية ناجحة، ويمكن إعادة مزامنتها لاحقًا.' : 'The server could not be reached. The operation was not confirmed and can be retried later.';
  if (text.includes('closed business day') || text.includes('business day is closed')) return ar ? 'اليوم التشغيلي مغلق. لا يمكن تنفيذ هذه العملية من الحساب العادي.' : 'The business day is closed. This operation is not allowed for a regular admin.';
  if (text.includes('inactive customer') || text.includes('customer is deactivated')) return ar ? 'العميل غير نشط ولا يمكن تنفيذ معاملة جديدة عليه.' : 'The customer is inactive and cannot receive new transactions.';
  return raw || (ar ? 'حدث خطأ غير متوقع. لم يتم تأكيد نجاح العملية.' : 'An unexpected error occurred. The operation was not confirmed as successful.');
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

