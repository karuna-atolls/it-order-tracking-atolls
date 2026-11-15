/**
 * Read-only Gmail access through the service account (domain-wide delegation, scope gmail.readonly).
 * The app only ever asks Gmail for messages from the allow-listed supplier senders.
 */
import { env } from '../env';
import type { EmailMessage } from '../types';
import { googleToken } from './google';
import { requestJson } from './http';

async function gmail<T = any>(path: string): Promise<T> {
  const token = await googleToken('https://www.googleapis.com/auth/gmail.readonly', env('GMAIL_MAILBOX'));
  return requestJson<T>(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, `Gmail ${path.split('?')[0]}`);
}

export async function listMessageIds(q: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${params}`);
    ids.push(...(r.messages || []).map((m) => m.id));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }

const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

function findBody(part: Part, mime: string): string {
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const p of part.parts || []) {
    const found = findBody(p, mime);
    if (found) return found;
  }
  return '';
}

/** HTML -> text, keeping link targets (tracking links matter). */
export const htmlToText = (html: string) => html
  .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<a\s[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1] ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|tr|div|li|h\d|table)>/gi, '\n')
  .replace(/<\/t[dh]>/gi, '  ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

export const cleanText = (text: string) =>
  text.replace(/\r/g, '').replace(/[ \t]{2,}/g, '  ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim().slice(0, 40000);

/** "Name <a@b.com>" -> "a@b.com" */
export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();

export async function getMessage(id: string): Promise<EmailMessage> {
  const m = await gmail<{ id: string; internalDate?: string; payload: Part }>(`/messages/${id}?format=full`);
  const header = (n: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value || '';
  const html = findBody(m.payload, 'text/html');
  const from = header('from');
  return {
    id: m.id,
    subject: header('subject'),
    from,
    fromAddress: addressOf(from),
    receivedAt: new Date(Number(m.internalDate) || Date.now()).toISOString(),
    body: cleanText(html ? htmlToText(html) : findBody(m.payload, 'text/plain')),
  };
}
