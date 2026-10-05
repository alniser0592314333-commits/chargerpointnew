/**
 * Phase 5 Auth & Security Core Rules & Models
 */

import { ID } from '../types/common';

export interface AdminEntity {
  id: ID;
  authUserId: ID;
  username: string;
  email: string;
  binHash?: string;
  isActive: boolean;
  role: 'Super Admin' | 'Manager' | 'Operator' | 'Finance' | 'Viewer' | 'Custom';
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
  disabledBy?: ID;
  version: number;
}

export interface AppDeviceEntity {
  id: ID;
  adminId: ID;
  deviceIdentifier: string;
  platform: string;
  appVersion: string;
  registeredAt: string;
  lastSeenAt: string;
  isActive: boolean;
  version: number;
}

export class AuthSecurityRules {
  static resolveEffectivePermissions(
    admin: AdminEntity,
    rolePermissionsMap: Record<string, string[]>,
    customGrants: string[] = [],
    customDenials: string[] = []
  ): Set<string> {
    if (!admin.isActive) return new Set();

    const basePermissions = rolePermissionsMap[admin.role] || [];
    const effective = new Set<string>(basePermissions);

    for (const d of customDenials) {
      effective.delete(d);
    }
    for (const g of customGrants) {
      effective.add(g);
    }
    return effective;
  }

  static canModifyAdmin(actorRole: string, targetRole: string): boolean {
    return actorRole === 'Super Admin' && targetRole !== 'Super Admin';
  }
}
