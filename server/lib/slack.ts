import crypto from 'node:crypto';
import { config } from '../config';
import { env } from '../env';

type SlackResult<T> = T & { ok: boolean; error?: string };

async function slack<T = any>(method: string, opts: { query?: Record<string, string>; body?: unknown }): Promise<SlackResult<T>> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const res = await fetch(`https://slack.com/api/${method}${qs}`, {
    method: opts.body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env('SLACK_BOT_TOKEN')}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json() as Promise<SlackResult<T>>;
}

async function call<T = any>(method: string, body: unknown): Promise<SlackResult<T>> {
  const r = await slack<T>(method, { body });
  if (!r.ok) throw new Error(`Slack ${method} failed: ${r.error}`);
  return r;
}

/** Slack sends button clicks and forms signed with the app's signing secret. */
export function verifySignature(rawBody: string, timestamp: string, signature: string): boolean {
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', env('SLACK_SIGNING_SECRET')).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const channels = new Map<string, string>();
let channelsLoadedAt = 0;
async function loadChannels() {
  if (Date.now() - channelsLoadedAt < 60_000) return;
  channelsLoadedAt = Date.now();
  let cursor = '';
  do {
    const r = await slack<{ channels?: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } }>('conversations.list', {
      query: { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}) },
    });
    if (!r.ok) throw new Error(`Slack conversations.list failed: ${r.error}`);
    for (const c of r.channels || []) channels.set(c.name.toLowerCase(), c.id);
    cursor = r.response_metadata?.next_cursor || '';
  } while (cursor);
}

/** Channel name ("munich-it", "#munich-it") or ID -> ID. Private channels are only found once the bot is a member. */
export async function channelId(nameOrId: string): Promise<string | null> {
  if (/^[CGD][A-Z0-9]{8,}$/.test(nameOrId)) return nameOrId;
  const name = nameOrId.replace(/^#/, '').toLowerCase();
  if (!channels.has(name)) await loadChannels();
  return channels.get(name) ?? null;
}

async function requireChannel(nameOrId: string): Promise<string> {
  const id = await channelId(nameOrId);
  if (!id) throw new Error(`Slack channel "${nameOrId}" not found — invite the bot to it`);
  return id;
}

const users = new Map<string, string | null>();
/** Slack user ID for an email; also tries the same name on the other company domains. */
export async function findUserId(email: string | null): Promise<string | null> {
  if (!email) return null;
  const key = email.toLowerCase();
  if (users.has(key) && users.get(key)) return users.get(key)!;
  const local = key.split('@')[0];
  const candidates = [key, ...config.slack.emailDomains.map((d) => `${local}@${d}`)].filter((v, i, a) => a.indexOf(v) === i);
  for (const candidate of candidates) {
    const r = await slack<{ user?: { id: string } }>('users.lookupByEmail', { query: { email: candidate } });
    if (r.ok && r.user) {
      users.set(key, r.user.id);
      return r.user.id;
    }
  }
  return null;
}

export interface Posted { channel: string; ts: string }

/** Post to a channel (name or ID) or DM a user (user ID). Returns where the message landed. */
export async function post(target: string, text: string, opts: { blocks?: unknown[]; threadTs?: string | null } = {}): Promise<Posted> {
  const channel = /^[UW][A-Z0-9]{6,}$/.test(target) ? target : await requireChannel(target);
  const r = await call<{ channel: string; ts: string }>('chat.postMessage', {
    channel, text, blocks: opts.blocks?.length ? opts.blocks : undefined, thread_ts: opts.threadTs || undefined, unfurl_links: false, unfurl_media: false,
  });
  return { channel: r.channel, ts: r.ts };
}

export async function update(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
  await call('chat.update', { channel: await requireChannel(channel), ts, text, blocks: blocks || [] });
}

export async function postEphemeral(channel: string, user: string, text: string): Promise<void> {
  await call('chat.postEphemeral', { channel: await requireChannel(channel), user, text });
}

export const openView = (triggerId: string, view: unknown) => call('views.open', { trigger_id: triggerId, view });

// ---- Block Kit helpers
export const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } });
export const button = (text: string, actionId: string, value: string, primary = false) => ({
  type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value, ...(primary ? { style: 'primary' } : {}),
});
export const actions = (...elements: unknown[]) => ({ type: 'actions', elements });

/** Setup helper: which of the configured channels the bot can post to. */
export async function channelCheck(): Promise<Record<string, boolean>> {
  const names = [config.slack.masterChannel, ...Object.values(config.slack.officeChannels)];
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = !!(await channelId(n).catch(() => null));
  return out;
}
