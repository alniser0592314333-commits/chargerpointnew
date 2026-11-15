import { list } from '@vercel/blob';
import type { ApiRequest, ApiResponse, ReleaseChannel } from '../_lib/appReleaseAuth.js';
import { parseReleaseVersion, requireSuperAdmin, sendJson, updateReleasePolicy } from '../_lib/appReleaseAuth.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store, private');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); }
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = req.body as { channel?: ReleaseChannel; url?: string } | undefined;
  const channel = body?.channel;
  if ((channel !== 'customer' && channel !== 'admin') || typeof body?.url !== 'string') return sendJson(res, 400, { error: 'INVALID_RESTORE_REQUEST' });
  try {
    const target = new URL(body.url);
    if (!target.hostname.endsWith('.public.blob.vercel-storage.com') || !target.pathname.startsWith(`/apk/${channel}/`)) {
      return sendJson(res, 400, { error: 'BLOB_NOT_IN_CHANNEL_HISTORY' });
    }
    const match = target.pathname.match(/^\/apk\/(customer|admin)\/([^/]+)\//);
    const version = parseReleaseVersion(match?.[2]);
    if (!version || match?.[1] !== channel) return sendJson(res, 400, { error: 'INVALID_RELEASE_VERSION' });
    let cursor: string | undefined;
    let found = false;
    for (let page = 0; page < 20 && !found; page += 1) {
      const result = await list({ prefix: `apk/${channel}/`, limit: 1000, cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
      found = result.blobs.some((blob) => blob.url === body.url);
      if (!result.hasMore || !result.cursor) break;
      cursor = result.cursor;
    }
    if (!found) return sendJson(res, 404, { error: 'RELEASE_NOT_FOUND' });
    const policy = await updateReleasePolicy(auth, channel, {
      latest_version: version.version, version_code: version.code,
      release_notes: `تمت استعادة الإصدار ${version.version}`, download_url: body.url,
      grace_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    return sendJson(res, 200, { success: true, policy });
  } catch { return sendJson(res, 500, { error: 'RELEASE_RESTORE_FAILED' }); }
}
