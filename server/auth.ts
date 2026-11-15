/** Dashboard login (ADMIN_PASSWORD) and shared-secret checks for the scheduler and the Jira webhook. */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env, hasEnv } from './env';

const COOKIE = 'ion_session';
const MAX_AGE_S = 12 * 3600;

const sign = (payload: string) => crypto.createHmac('sha256', env('ADMIN_PASSWORD')).update(payload).digest('base64url');

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export function login(req: Request, res: Response) {
  if (!hasEnv('ADMIN_PASSWORD')) return res.status(500).json({ error: 'ADMIN_PASSWORD secret is not set' });
  if (!safeEqual(String(req.body?.password || ''), env('ADMIN_PASSWORD'))) return res.status(401).json({ error: 'Wrong password' });
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // SameSite=None lets the login work inside the AI Studio preview frame; it requires Secure.
  res.setHeader('Set-Cookie',
    `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; Path=/; Max-Age=${MAX_AGE_S}; ${secure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`);
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
}

export function isAdmin(req: Request): boolean {
  if (!hasEnv('ADMIN_PASSWORD')) return false;
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const [exp, sig] = v.split('.');
  return !!exp && !!sig && Number(exp) > Date.now() / 1000 && safeEqual(sig, sign(exp));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

/** Cloud Scheduler sends the header "x-cron-secret"; a signed-in admin may also trigger jobs. */
export function requireCronOrAdmin(req: Request, res: Response, next: NextFunction) {
  const given = String(req.headers['x-cron-secret'] || '');
  if ((hasEnv('CRON_SECRET') && given && safeEqual(given, env('CRON_SECRET'))) || isAdmin(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

export function requireWebhookToken(req: Request, res: Response, next: NextFunction) {
  const given = String(req.query.token || '');
  if (hasEnv('JIRA_WEBHOOK_TOKEN') && given && safeEqual(given, env('JIRA_WEBHOOK_TOKEN'))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
