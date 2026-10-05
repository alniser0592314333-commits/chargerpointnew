/**
 * Domain Layer - Type Definitions & Structural Contracts
 * Pure TypeScript interfaces representing domain entities without mock database data.
 */

import { BaseEntity, ID, SyncMetadata } from '../types/common';

// Structural stub for future domain entities
export interface TenantConfig extends BaseEntity {
  name: string;
  currency: string;
  timezone: string;
  locale: string;
}

export type EntitySync<T> = T & {
  sync: SyncMetadata;
};
