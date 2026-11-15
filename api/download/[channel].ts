import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

type DownloadChannel = 'customer' | 'admin';

function json(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message }));
}

function isSafeHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    const allowedHost = host === 'github.com' || host === 'release-assets.githubusercontent.com' ||
      host === 'objects.githubusercontent.com' || host.endsWith('.public.blob.vercel-storage.com');
    if (!allowedHost) return null;
    // Prevent obvious private / loopback / link-local IPv4 destinations.
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a, b] = ipv4.slice(1).map(Number);
      if ([a, b].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168)) return null;
    }
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchFollowingSafeRedirects(initialUrl: string, method: 'GET' | 'HEAD'): Promise<Response> {
  let current = isSafeHttpsUrl(initialUrl);
  if (!current) throw new Error('INVALID_DOWNLOAD_URL');

  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(current, { method, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || hop === 5) throw new Error('DOWNLOAD_REDIRECT_LIMIT');
    const next = isSafeHttpsUrl(new URL(location, current).toString());
    if (!next) throw new Error('UNSAFE_DOWNLOAD_REDIRECT');
    current = next;
  }
  throw new Error('DOWNLOAD_REDIRECT_LIMIT');
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return json(res, 405, 'METHOD_NOT_ALLOWED');
  }

  const channelMatch = new URL(req.url || '/', 'https://internal.invalid').pathname.match(/^\/api\/download\/(customer|admin)$/);
  const channel = channelMatch?.[1] as DownloadChannel | undefined;
  if (!channel) return json(res, 404, 'NOT_FOUND');

  // Keep the administrator APK endpoint off the public customer hostname.
  // Customer downloads are likewise served only from the canonical public host.
  const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
  if ((channel === 'admin' && requestHost !== 'admin.monther.work') ||
      (channel === 'customer' && requestHost === 'admin.monther.work')) {
    return json(res, 404, 'NOT_FOUND');
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ydhcyamtgioyrxfarkwk.supabase.co';
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_dXsrK8ltM6DCZ88HgfP27w_bxb3rvGN';
  if (!anonKey) return json(res, 503, 'DOWNLOAD_CONFIGURATION_UNAVAILABLE');

  try {
    const policyUrl = new URL('/rest/v1/app_release_policies', supabaseUrl);
    policyUrl.search = new URLSearchParams({
      select: 'latest_version,download_url',
      channel: 'eq.' + channel,
      limit: '1',
    }).toString();

    const policyResponse = await fetch(policyUrl, {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey },
      cache: 'no-store',
    });
    if (!policyResponse.ok) return json(res, 502, 'RELEASE_POLICY_UNAVAILABLE');

    const rows = await policyResponse.json() as Array<{ latest_version?: string; download_url?: string }>;
    const latestVersion = rows?.[0]?.latest_version?.trim();
    // Never persist or reuse GitHub's temporary release-assets URL: it expires.
    // Build the stable release URL from the authoritative channel + version.
    if (!latestVersion || !/^(0|[1-9][0-9]{0,3})[.](0|[1-9][0-9]{0,2})[.](0|[1-9][0-9]{0,2})$/.test(latestVersion)) {
      return json(res, 404, 'APK_RELEASE_VERSION_UNAVAILABLE');
    }
    const assetName = `ChargerPoint-${channel}-v${latestVersion}.apk`;
    const storedUrl = rows?.[0]?.download_url?.trim() || '';
    let sourceUrl = `https://github.com/alniser0592314333-commits/chargerpointnew/releases/download/v${latestVersion}/${assetName}`;
    // New releases use immutable public Blob URLs. Legacy policy rows may contain
    // expired GitHub signed-asset URLs, so retain the stable GitHub release fallback.
    if (storedUrl) {
      const stored = isSafeHttpsUrl(storedUrl);
      if (stored && stored.hostname.toLowerCase().endsWith('.public.blob.vercel-storage.com') &&
          stored.pathname.startsWith(`/apk/${channel}/`)) {
        sourceUrl = stored.toString();
      }
    }

    const fileResponse = await fetchFollowingSafeRedirects(sourceUrl, req.method);
    if (!fileResponse.ok || (req.method === 'GET' && !fileResponse.body)) {
      return json(res, 502, 'APK_FILE_UNAVAILABLE');
    }

    const filename = channel === 'customer' ? 'ChargerPoint-customer.apk' : 'ChargerPoint-admin.apk';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const contentLength = fileResponse.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (req.method === 'HEAD') return res.end();

    Readable.fromWeb(fileResponse.body as import('node:stream/web').ReadableStream).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return json(res, 502, message === 'INVALID_DOWNLOAD_URL' || message === 'UNSAFE_DOWNLOAD_REDIRECT'
      ? 'APK_DOWNLOAD_URL_INVALID'
      : 'APK_DOWNLOAD_FAILED');
  }
}
