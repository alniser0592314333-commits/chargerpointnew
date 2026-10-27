import { localDb } from '../localDb/localDb';
import { getSyncDiagnosticJournal } from './syncDiagnosticJournal';

type JsonRecord = Record<string, unknown>;

const SECRET_KEY = /(password|passwd|secret|token|authorization|api.?key|service.?role|\bbin\b|\bpin\b|receipt.?url|proof.?url|private.?key|credential|phone|mobile|email)/i;

function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT REDACTED]')
      .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[QUERY REDACTED]');
  }
  if (value && typeof value === 'object') {
    const out: JsonRecord = {};
    for (const [childKey, childValue] of Object.entries(value as JsonRecord)) {
      out[childKey] = redact(childValue, childKey);
    }
    return out;
  }
  return value;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function put16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}
function put32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Minimal standards-compliant ZIP writer using STORE (no dependency/runtime compression API). */
function createZip(files: Array<{ name: string; content: string }>): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  const stamp = dosDateTime();

  for (const file of files) {
    const name = utf8(file.name);
    const data = utf8(file.content);
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    put32(localView, 0, 0x04034b50);
    put16(localView, 4, 20);
    put16(localView, 6, 0x0800);
    put16(localView, 8, 0);
    put16(localView, 10, stamp.time);
    put16(localView, 12, stamp.date);
    put32(localView, 14, crc);
    put32(localView, 18, data.length);
    put32(localView, 22, data.length);
    put16(localView, 26, name.length);
    put16(localView, 28, 0);
    localHeader.set(name, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    put32(centralView, 0, 0x02014b50);
    put16(centralView, 4, 20);
    put16(centralView, 6, 20);
    put16(centralView, 8, 0x0800);
    put16(centralView, 10, 0);
    put16(centralView, 12, stamp.time);
    put16(centralView, 14, stamp.date);
    put32(centralView, 16, crc);
    put32(centralView, 20, data.length);
    put32(centralView, 24, data.length);
    put16(centralView, 28, name.length);
    put16(centralView, 30, 0);
    put16(centralView, 32, 0);
    put16(centralView, 34, 0);
    put16(centralView, 36, 0);
    put32(centralView, 38, 0);
    put32(centralView, 42, localOffset);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const centralDirectory = concat(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  put32(endView, 0, 0x06054b50);
  put16(endView, 4, 0);
  put16(endView, 6, 0);
  put16(endView, 8, files.length);
  put16(endView, 10, files.length);
  put32(endView, 12, centralDirectory.length);
  put32(endView, 16, localOffset);
  put16(endView, 20, 0);
  const archive = concat([...localParts, centralDirectory, end]);
  const archiveBuffer = new ArrayBuffer(archive.length);
  new Uint8Array(archiveBuffer).set(archive);
  return new Blob([archiveBuffer], { type: 'application/zip' });
}

function jsonFile(value: unknown): string {
  return JSON.stringify(redact(value), null, 2);
}

export async function downloadSyncFailureBundle(): Promise<{ filename: string; bytes: number; failed: number; pending: number; blocked: number }> {
  const snapshot = await localDb.captureRecoverySnapshot();
  const outbox = snapshot.outbox || [];
  const history = snapshot.syncHistory || [];
  const failedStates = new Set(['FAILED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CONFLICT', 'BLOCKED', 'WAITING_DEPENDENCY']);
  const pendingStates = new Set(['PENDING', 'READY', 'SYNCING', 'ATTEMPTING']);
  const failedHistory = history.filter((item) => failedStates.has(item.state));
  const pendingHistory = history.filter((item) => pendingStates.has(item.state));
  const activeIds = new Set([
    ...outbox.map((item) => item.commandId),
    ...failedHistory.map((item) => item.commandId),
    ...pendingHistory.map((item) => item.commandId),
  ]);
  const mutationSnapshots = (snapshot.mutationSnapshots || []).filter((item) => activeIds.has(item.commandId));
  const optimisticOverlays = (snapshot.optimisticOverlays || []).filter((item) => activeIds.has(item.commandId));
  const runtimeEvents = getSyncDiagnosticJournal();
  const now = new Date();
  const filename = `chargerpoint-sync-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.zip`;

  const manifest = {
    format: 'ChargerPoint Sync Diagnostic Bundle',
    schemaVersion: 1,
    createdAt: now.toISOString(),
    app: {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unavailable',
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      language: typeof navigator !== 'undefined' ? navigator.language : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    counts: {
      outboxTotal: outbox.length,
      outboxFailed: outbox.filter((item) => ['rejected', 'conflict'].includes(item.status)).length,
      outboxBlocked: outbox.filter((item) => item.status === 'blocked').length,
      outboxPending: outbox.filter((item) => ['pending', 'syncing', 'PENDING_RECONCILIATION', 'READY'].includes(item.status)).length,
      historyFailed: failedHistory.length,
      historyPending: pendingHistory.length,
      mutationSnapshots: mutationSnapshots.length,
      optimisticOverlays: optimisticOverlays.length,
      runtimeEvents: runtimeEvents.length,
    },
    privacy: 'Sensitive credential-like fields are redacted. Operational identifiers, error messages, timestamps and financial payload fields are retained for diagnosis. Review the archive before sharing.',
    notes: [
      'This bundle is a local snapshot; it does not modify, retry, delete, or upload queued operations.',
      'A command absent from the outbox may already have been accepted remotely; use commandId/idempotency evidence before any manual repair.',
      'Successful history is included to help reconstruct dependency chains.',
    ],
  };

  const files = [
    { name: 'README.txt', content: [
      'ChargerPoint synchronization diagnostic bundle',
      '',
      'Start with manifest.json, then inspect outbox.json and sync-history.json.',
      'failed-and-blocked.json contains failed, conflicting, blocked and dependency-waiting operations.',
      'pending.json contains commands that have not reached a confirmed terminal state.',
      'mutation-snapshots.json and optimistic-overlays.json help determine whether local optimistic state needs reconciliation.',
      'runtime-events.json contains a bounded local journal of sync transitions plus uncaught JavaScript errors and unhandled promise rejections.',
      'local-record-counts.json reports counts only; operational customer/order tables are not exported wholesale.',
      '',
      'Security: credential-like values are redacted, but this file may still contain business/customer identifiers and error details. Share it only with the intended support recipient.',
    ].join('\n') },
    { name: 'manifest.json', content: jsonFile(manifest) },
    { name: 'outbox.json', content: jsonFile(outbox) },
    { name: 'failed-and-blocked.json', content: jsonFile({
      outbox: outbox.filter((item) => ['rejected', 'conflict', 'blocked'].includes(item.status)),
      history: failedHistory,
    }) },
    { name: 'pending.json', content: jsonFile({
      outbox: outbox.filter((item) => ['pending', 'syncing', 'PENDING_RECONCILIATION', 'READY'].includes(item.status)),
      history: pendingHistory,
    }) },
    { name: 'sync-history.json', content: jsonFile(history) },
    { name: 'sync-state.json', content: jsonFile(snapshot.syncState) },
    { name: 'mutation-snapshots.json', content: jsonFile(mutationSnapshots) },
    { name: 'optimistic-overlays.json', content: jsonFile(optimisticOverlays) },
    { name: 'runtime-events.json', content: jsonFile(runtimeEvents) },
    { name: 'local-record-counts.json', content: jsonFile(Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length]))) },
  ];

  const blob = createZip(files);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return {
    filename,
    bytes: blob.size,
    failed: manifest.counts.outboxFailed + manifest.counts.historyFailed,
    pending: manifest.counts.outboxPending + manifest.counts.historyPending,
    blocked: manifest.counts.outboxBlocked,
  };
}
