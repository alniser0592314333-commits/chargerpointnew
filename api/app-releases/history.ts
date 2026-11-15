import { list } from '@vercel/blob';
import type { ApiRequest, ApiResponse, ReleaseChannel } from '../_lib/appReleaseAuth';
import { requireSuperAdmin, sendJson } from '../_lib/appReleaseAuth';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store, private');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); }
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const channel = new URL(req.url || '/', 'https://internal.invalid').searchParams.get('channel') as ReleaseChannel | null;
  if (channel !== 'customer' && channel !== 'admin') return sendJson(res, 400, { error: 'INVALID_CHANNEL' });
  try {
    const blobs = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await list({ prefix: `apk/${channel}/`, limit: 1000, cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
      blobs.push(...result.blobs);
      if (!result.hasMore || !result.cursor) break;
      cursor = result.cursor;
    }
    const releases = blobs.map((blob) => {
      const match = blob.pathname.match(/^apk\/(customer|admin)\/([^/]+)\//);
      return { url: blob.url, pathname: blob.pathname, version: match?.[2] || 'unknown', size: blob.size, uploadedAt: blob.uploadedAt };
    }).sort((a, b) => Date.parse(String(b.uploadedAt)) - Date.parse(String(a.uploadedAt)));
    return sendJson(res, 200, { releases });
  } catch { return sendJson(res, 500, { error: 'RELEASE_HISTORY_UNAVAILABLE' }); }
}
