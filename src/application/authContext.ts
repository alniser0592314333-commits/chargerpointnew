/**
 * Application Authorization Abstraction Context
 */

import { UserRole, Permission } from '../domain/enums';
import { ID } from '../types/common';
import { AuthorizationError, BinRequiredError, InsufficientPermissionError } from '../domain/errors';

export interface ActorAdmin {
  id: ID;
  username: string;
  fullName: string;
  role: UserRole;
  permissions: Permission[];
  isSuperAdmin: boolean;
  deviceId?: ID;
}

export type BinVerifierFn = (bin: string, actor: ActorAdmin) => boolean | Promise<boolean>;

export class AuthorizationContext {
  constructor(
    private actor: ActorAdmin | null,
    private binVerifier?: BinVerifierFn
  ) {}

  public requireAuth(): ActorAdmin {
    if (!this.actor) {
      throw new AuthorizationError('Authentication required');
    }
    return this.actor;
  }

  public hasPermission(permission: Permission): boolean {
    if (!this.actor) return false;
    if (this.actor.isSuperAdmin || this.actor.role === 'SUPER_ADMIN') return true;
    return this.actor.permissions.includes(permission);
  }

  public assertPermission(permission: Permission): void {
    if (!this.hasPermission(permission)) {
      throw new InsufficientPermissionError(`Missing required permission: ${permission}`);
    }
  }

  public hasBinVerifier(): boolean {
    return Boolean(this.binVerifier);
  }

  public verifyBin(bin: string): void | Promise<void> {
    const actor = this.requireAuth();
    if (!bin || typeof bin !== 'string' || bin.trim().length < 4 || !/^\d{4,}$/.test(bin.trim())) {
      throw new BinRequiredError('Valid numeric BIN of at least 4 digits is required');
    }

    if (!this.binVerifier) {
      throw new AuthorizationError('BIN verifier not configured or unavailable');
    }

    let result: boolean | Promise<boolean>;
    try {
      result = this.binVerifier(bin.trim(), actor);
    } catch (err: any) {
      if (err instanceof BinRequiredError || err instanceof AuthorizationError) {
        throw err;
      }
      throw new AuthorizationError('Invalid BIN credential for authenticated admin');
    }

    if (result instanceof Promise) {
      return result
        .then((isValid) => {
          if (!isValid) {
            throw new AuthorizationError('Invalid BIN credential for authenticated admin');
          }
        })
        .catch((err) => {
          if (err instanceof BinRequiredError || err instanceof AuthorizationError) {
            throw err;
          }
          throw new AuthorizationError('Invalid BIN credential for authenticated admin');
        });
    }

    if (!result) {
      throw new AuthorizationError('Invalid BIN credential for authenticated admin');
    }
  }
}
