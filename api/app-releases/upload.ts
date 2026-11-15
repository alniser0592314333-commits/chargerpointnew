import { put } from '@vercel/blob';
import type { IncomingMessage } from 'node:http';
import { parseReleaseVersion, requireSuperAdmin, sendJson, updateReleasePolicy, type ApiRequest, type ApiResponse, type ReleaseChannel } from '../_lib/appReleaseAuth.js';

const MAX_APK_BYTES = 4 * 1024 * 1024;
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_APK_BYTES) throw new Error('APK_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}
export const config = { api: { bodyParser: false } };

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store, private');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); }
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const channel = req.headers['x-release-channel'] as ReleaseChannel;
  const version = parseReleaseVersion(req.headers['x-release-version']);
  let notes = String(req.headers['x-release-notes'] || '').slice(0, 4500);
  try { notes = decodeURIComponent(notes).slice(0, 1500); } catch { return sendJson(res, 400, { error: 'INVALID_RELEASE_NOTES' }); }
  const graceUntil = new Date(String(req.headers['x-release-grace-until'] || ''));
  if (!['customer', 'admin'].includes(channel) || !version || !Number.isFinite(graceUntil.getTime()) || graceUntil.getTime() <= Date.now()) {
    return sendJson(res, 400, { error: 'INVALID_RELEASE_METADATA' });
  }
  try {
    const file = await readBody(req);
    if (file.length < 1000 || file[0] !== 0x50 || file[1] !== 0x4b) return sendJson(res, 400, { error: 'INVALID_APK_FILE' });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return sendJson(res, 503, { error: 'BLOB_STORAGE_NOT_CONFIGURED' });
    const pathname = `apk/${channel}/${version.version}/ChargerPoint-${channel}-v${version.version}.apk`;
    const blob = await put(pathname, file, {
      access: 'public', addRandomSuffix: true,
      contentType: 'application/vnd.android.package-archive',
      cacheControlMaxAge: 31536000, token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    const policy = await updateReleasePolicy(auth, channel, {
      latest_version: version.version, version_code: version.code,
      release_notes: notes, download_url: blob.url, grace_until: graceUntil.toISOString(),
    });
    return sendJson(res, 200, { success: true, channel, version: version.version, size: file.length, url: blob.url, uploadedAt: new Date().toISOString(), policy });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return sendJson(res, message === 'APK_TOO_LARGE' ? 413 : 500, { error: message === 'APK_TOO_LARGE' ? message : 'RELEASE_UPLOAD_FAILED' });
  }
}
