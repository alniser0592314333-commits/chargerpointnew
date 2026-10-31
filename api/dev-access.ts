import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'cpn_dev_access';
const MAX_AGE_SECONDS = 60 * 60;

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function validCookie(cookieHeader: string | undefined, secret: string): boolean {
  const token = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);
  if (!token) return false;
  const [issuedAtText, suppliedSignature] = token.split('.');
  if (!issuedAtText || !suppliedSignature || !/^\d+$/.test(issuedAtText)) return false;
  const issuedAt = Number(issuedAtText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 30 || now - issuedAt > MAX_AGE_SECONDS) return false;
  const expected = signature(issuedAtText, secret);
  const supplied = Buffer.from(suppliedSignature, 'hex');
  const actual = Buffer.from(expected, 'hex');
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Vary', 'Cookie');
  const expectedCode = process.env.DEV_GATE_CODE;
  const secret = process.env.DEV_GATE_SECRET;
  if (!expectedCode || !secret || secret.length < 32) {
    return res.status(503).json({ ok: false, error: 'Development gate is not configured.' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ok: validCookie(req.headers.cookie, secret) });
  }

  if (req.method === 'POST') {
    const suppliedCode = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const expected = Buffer.from(expectedCode);
    const supplied = Buffer.from(suppliedCode);
    const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
    if (!matches) return res.status(401).json({ ok: false, error: 'Invalid development code.' });

    const issuedAt = String(Math.floor(Date.now() / 1000));
    const token = issuedAt + '.' + signature(issuedAt, secret);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/public; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}`);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}
