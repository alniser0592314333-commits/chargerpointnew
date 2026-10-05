/**
 * Core Shared TypeScript Types & Strict Abstractions
 * Zero 'any' policy.
 */

export type ID = string;

export type Timestamp = string; // ISO 8601

export interface BaseEntity {
  id: ID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  version: number;
}

export type Result<T, E = string> = 
  | { success: true; data: T }
  | { success: false; error: E; code?: string };

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export type SyncStatus = 'synced' | 'pending' | 'conflict' | 'error';

export interface SyncMetadata {
  syncStatus: SyncStatus;
  lastSyncedAt?: Timestamp;
  localVersion: number;
  serverVersion?: number;
}
