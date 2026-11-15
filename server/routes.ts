import { Router, type NextFunction, type Request, type Response } from 'express';
import { isAdmin, login, logout, requireAdmin, requireCronOrAdmin, requireWebhookToken } from './auth';
import { config } from './config';
import { hasEnv, SECRET_NAMES } from './env';
import * as jira from './lib/jira';
import * as slack from './lib/slack';
import { errorText, log, recentLog } from './log';
import { getSettings, setAutoSend } from './settings';
import { store, usingFirestore } from './store';
import { assetsCheck } from './jobs/createAssets';
import { finalizeOrder, finalizeWaiting } from './jobs/finalize';
import { handleJiraWebhook } from './jobs/jiraWebhook';
import { alertAdmin } from './jobs/notify';
import { markDelivered, pollEmails, previewEmail, processPending } from './jobs/processEmails';
import { sendDigests, sendReminders } from './jobs/reminders';
import { handleInteraction } from './jobs/slackInteractions';
import type { OrderState, PendingEmail } from './types';

export const api = Router();

/** Wrap async handlers: errors -> JSON 500 + log (+ admin alert for scheduled jobs). */
const handle = (where: string, fn: (req: Request) => Promise<unknown>, alert = false) =>
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      log('error', `${where}: ${errorText(e)}`);
      if (alert) await alertAdmin(null, `${where} failed: ${errorText(e)}`).catch(() => undefined);
      res.status(500).json({ error: errorText(e) });
    }
  };

api.get('/health', (_req, res) => res.json({ ok: true }));

// --- dashboard session
api.post('/login', login);
api.post('/logout', logout);
api.get('/me', (req, res) => res.json({ signedIn: isAdmin(req) }));

// --- scheduled jobs (Cloud Scheduler, or the dashboard buttons)
api.post('/cron/poll', requireCronOrAdmin, handle('Email check', async () => ({
  emails: await pollEmails(),
  linkedFromSlack: await processPending(), // safety net for work started from Slack
  closingsRetried: await finalizeWaiting(),
}), true));
api.post('/cron/digest', requireCronOrAdmin, handle('Requester digest', () => sendDigests(), true));
api.post('/cron/reminders', requireCronOrAdmin, handle('Reminders', () => sendReminders(), true));

// --- Jira webhook (issue updated, comment created)
api.post('/webhooks/jira', requireWebhookToken, handle('Jira webhook', async (req) => ({ result: await handleJiraWebhook(req.body) })));

/** Slack interactivity (buttons + forms). Mounted with a raw body parser in server.ts. */
export async function slackInteractions(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const ok = hasEnv('SLACK_SIGNING_SECRET')
    && slack.verifySignature(raw, String(req.headers['x-slack-request-timestamp'] || ''), String(req.headers['x-slack-signature'] || ''));
  if (!ok) return res.status(401).send('bad signature');
  try {
    const payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}');
    const result = await handleInteraction(payload);
    if (result.response) res.json(result.response); else res.status(200).send();
    if (result.after) setImmediate(() => result.after!().catch((e) => log('error', `Slack follow-up: ${errorText(e)}`)));
  } catch (e) {
    log('error', `Slack interaction: ${errorText(e)}`);
    if (!res.headersSent) res.status(200).send(); // Slack shows a generic error otherwise; details are in the log
  }
}

// --- dashboard data (admin only)
api.get('/setup', requireAdmin, handle('Setup', async () => ({
  settings: await getSettings(),
  secrets: Object.fromEntries(SECRET_NAMES.map((n) => [n, hasEnv(n)])),
  storage: usingFirestore() ? 'Firestore' : 'memory only (lost on restart)',
  config: {
    jiraBaseUrl: config.jira.baseUrl,
    projectKey: config.jira.projectKey,
    sources: config.sources.map((s) => ({ name: s.name, allowedSenders: s.allowedSenders })),
    geminiModel: config.gemini.model,
    userDmMode: config.notifications.userDmMode,
    todo: [
      jira.isConfigured(config.jira.fields.deliveryOffice) ? null : 'Set config.jira.fields.deliveryOffice (office deliveries are treated as home deliveries until then)',
    ].filter(Boolean),
  },
})));

api.post('/settings/auto-send', requireAdmin, handle('Automatic sending', async (req) => {
  const s = await setAutoSend(!!req.body?.enabled, 'dashboard');
  log('warn', `Automatic sending turned ${s.autoSend ? 'ON' : 'OFF (review mode)'} from the dashboard`);
  return s;
}));

api.get('/setup/slack', requireAdmin, handle('Slack check', () => slack.channelCheck()));
api.get('/setup/assets', requireAdmin, handle('Assets check', () => assetsCheck()));
api.get('/setup/jira-fields', requireAdmin, handle('Jira field search', (req) => jira.searchFields(String(req.query.q || 'office'))));

api.get('/orders', requireAdmin, handle('Load orders', async () =>
  (await store.listOpen<OrderState>('orders')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((o) => ({
    id: o.id, jiraKey: o.jiraKey, url: jira.ticketUrl(o.jiraKey), summary: o.summary, source: o.source, orderNumber: o.orderNumber,
    requester: o.requester.name, inSlack: !!o.requester.slackUserId, delivery: o.delivery.type === 'office' ? `${o.delivery.office} office` : 'Home',
    status: o.status, updatedAt: o.updatedAt, waitingForReceipt: !!o.deliveredNotifiedAt && !o.receiptConfirmedAt,
    queuedForUser: o.pendingUserEvents.length, waitingPreviews: (o.outbox || []).filter((d) => d.status === 'waiting').length, closingError: o.finalize.lastError,
    items: o.items.map((i) => ({ name: i.name, status: i.status, category: i.category, serials: i.serials.filter(Boolean), assets: i.assetKeys.filter(Boolean) })),
  }))));

api.get('/pending', requireAdmin, handle('Load pending', async () =>
  (await store.listOpen<PendingEmail>('pending')).map((p) => ({ id: p.id, source: p.source, subject: p.subject, reason: p.reason, orderNumber: p.extracted.orderNumber, receivedAt: p.receivedAt }))));

api.get('/log', requireAdmin, (_req, res) => res.json(recentLog()));

// --- dashboard actions (admin only)
api.post('/test/extract', requireAdmin, handle('Test extraction', async (req) => {
  const source = config.sources.find((s) => s.name === req.body?.source) || config.sources[0];
  return previewEmail({
    id: 'test', subject: String(req.body?.subject || ''), from: source.allowedSenders[0], fromAddress: source.allowedSenders[0],
    receivedAt: new Date().toISOString(), body: String(req.body?.body || '').slice(0, 40000),
  }, source);
}));

api.post('/actions/mark-delivered', requireAdmin, handle('Mark delivered', async (req) => {
  await markDelivered(String(req.body?.orderId || ''));
  return { ok: true };
}));

api.post('/actions/retry-closing', requireAdmin, handle('Retry closing', async (req) => {
  const id = String(req.body?.orderId || '');
  const order = await store.get<OrderState>('orders', id);
  if (!order) throw new Error('Order not found');
  order.finalize.attempts = 0;
  await store.set('orders', id, order, order.open);
  await finalizeOrder(id);
  return { ok: true, error: (await store.get<OrderState>('orders', id))?.finalize.lastError || null };
}));
