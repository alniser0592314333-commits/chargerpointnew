export type SarahAccountOperation = { accountId: string; generation: number };

/**
 * Monotonic account scope for invalidating async work after an identity switch.
 * Tokens are captured before awaits and checked before every UI-side effect.
 */
export class SarahAccountOperationScope {
  private accountId: string | null;
  private generationValue = 0;

  constructor(initialAccountId: string | null = null) {
    this.accountId = initialAccountId;
  }

  switchTo(accountId: string | null): number {
    if (this.accountId !== accountId) {
      this.accountId = accountId;
      this.generationValue += 1;
    }
    return this.generationValue;
  }

  begin(accountId: string): SarahAccountOperation | null {
    if (!accountId || this.accountId !== accountId) return null;
    return { accountId, generation: this.generationValue };
  }

  isCurrent(operation: SarahAccountOperation | null | undefined): boolean {
    return Boolean(
      operation &&
      this.accountId === operation.accountId &&
      this.generationValue === operation.generation
    );
  }

  isCurrentAccount(accountId: string | null | undefined): boolean {
    return Boolean(accountId && this.accountId === accountId);
  }

  get generation(): number {
    return this.generationValue;
  }
}
