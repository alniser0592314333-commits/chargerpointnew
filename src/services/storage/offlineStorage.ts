/**
 * Offline-First Storage & Sync Engine Architecture
 * Prepares abstractions for Local Database (IndexedDB), Outbox Pattern,
 * Commands queue, Sync Cursor, Change Feed, Conflict Handling, and Idempotency.
 */

import { Timestamp, ID } from '../../types/common';

export type OutboxActionType = 'CREATE' | 'UPDATE' | 'DELETE';

export interface OutboxItem<TPayload = unknown> {
  id: ID;
  entityName: string;
  action: OutboxActionType;
  payload: TPayload;
  idempotencyKey: string;
  createdAt: Timestamp;
  retryCount: number;
  lastError?: string;
}

export interface SyncCursor {
  lastPulledAt: Timestamp;
  serverVersion: number;
  cursorToken: string;
}

export interface OfflineStorageAdapter {
  get<T>(table: string, id: ID): Promise<T | null>;
  set<T>(table: string, id: ID, value: T): Promise<void>;
  remove(table: string, id: ID): Promise<void>;
  list<T>(table: string): Promise<T[]>;
  
  // Outbox operations for offline-first sync
  addToOutbox(item: Omit<OutboxItem, 'id' | 'createdAt' | 'retryCount'>): Promise<ID>;
  getOutboxQueue(): Promise<OutboxItem[]>;
  removeFromOutbox(id: ID): Promise<void>;
  incrementRetryCount(id: ID, error: string): Promise<void>;
  
  // Cursor management
  getSyncCursor(table: string): Promise<SyncCursor | null>;
  setSyncCursor(table: string, cursor: SyncCursor): Promise<void>;
}

/**
 * Memory/LocalStorage implementation stub for offline abstraction
 */
class InMemoryOfflineStorageAdapter implements OfflineStorageAdapter {
  private memoryStore = new Map<string, Map<ID, unknown>>();
  private outbox: OutboxItem[] = [];
  private cursors = new Map<string, SyncCursor>();

  private getTableMap(table: string): Map<ID, unknown> {
    if (!this.memoryStore.has(table)) {
      this.memoryStore.set(table, new Map());
    }
    return this.memoryStore.get(table)!;
  }

  async get<T>(table: string, id: ID): Promise<T | null> {
    const tableMap = this.getTableMap(table);
    return (tableMap.get(id) as T) || null;
  }

  async set<T>(table: string, id: ID, value: T): Promise<void> {
    const tableMap = this.getTableMap(table);
    tableMap.set(id, value);
  }

  async remove(table: string, id: ID): Promise<void> {
    const tableMap = this.getTableMap(table);
    tableMap.delete(id);
  }

  async list<T>(table: string): Promise<T[]> {
    const tableMap = this.getTableMap(table);
    return Array.from(tableMap.values()) as T[];
  }

  async addToOutbox(item: Omit<OutboxItem, 'id' | 'createdAt' | 'retryCount'>): Promise<ID> {
    const id = `outbox_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const fullItem: OutboxItem = {
      ...item,
      id,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };
    this.outbox.push(fullItem);
    return id;
  }

  async getOutboxQueue(): Promise<OutboxItem[]> {
    return [...this.outbox];
  }

  async removeFromOutbox(id: ID): Promise<void> {
    this.outbox = this.outbox.filter(item => item.id !== id);
  }

  async incrementRetryCount(id: ID, error: string): Promise<void> {
    const item = this.outbox.find(i => i.id === id);
    if (item) {
      item.retryCount += 1;
      item.lastError = error;
    }
  }

  async getSyncCursor(table: string): Promise<SyncCursor | null> {
    return this.cursors.get(table) || null;
  }

  async setSyncCursor(table: string, cursor: SyncCursor): Promise<void> {
    this.cursors.set(table, cursor);
  }
}

export const offlineStorage: OfflineStorageAdapter = new InMemoryOfflineStorageAdapter();
