/**
 * Supplier email -> order update. This is the entry point of the whole flow:
 * allowed sender -> Gemini -> Jira ticket (requester, office) -> stored order -> Jira comment, master channel,
 * requester DM (queued for the digest or sent at once), office channel.
 */
import { config } from '../config';
import * as assets from '../lib/assets';
import { extractEmail } from '../lib/gemini';
import { getMessage, listMessageIds } from '../lib/gmail';
import * as jira from '../lib/jira';
import * as slack from '../lib/slack';
import { errorText, log } from '../log';
import * as msg from '../messages';
import { autoSend } from '../settings';
import { store, withLock } from '../store';
import type { EmailMessage, ExtractedEmail, JiraIssue, OrderState, PendingEmail, Source } from '../types';
import { adminMention, alertAdmin, attempt, flushUser, officeNotice, queueForUser, saveOrder, syncMaster, threadPost } from './notify';
import { applyEmail } from './orders';

interface Ledger { ids: Record<string, { s: 'done' | 'retry' | 'failed'; n: number; t: number }> }
interface EmailRef { id: string; subject: string; receivedAt: string }

const sourceByName = (name: string) => config.sources.find((s) => s.name === name) || config.sources[0];
export const orderIdFor = (source: string, orderNumber: string | null, jiraKey: string | null) => `${source}-${orderNumber || jiraKey}`;

/** Jira field value (text, option, Assets object, array) -> plain text. */
async function fieldText(v: any): Promise<string | null> {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.length ? fieldText(v[0]) : null;
  if (v.value || v.name || v.label) return String(v.value || v.name || v.label);
  if (v.objectId) return (await assets.getObject(v.objectId).catch(() => null))?.label ?? null;
  return null;
}

/** "Munich" / "Munich Office" -> the office name used in config.slack.officeChannels. */
const canonicalOffice = (raw: string) =>
  Object.keys(config.slack.officeChannels).find((k) => raw.toLowerCase().includes(k.toLowerCase())) || raw;

export async function deliveryFromIssue(issue: JiraIssue): Promise<{ type: 'office' | 'home'; office: string | null }> {
  const field = config.jira.fields.deliveryOffice;
  const raw = jira.isConfigured(field) ? await fieldText(issue.fields[field]) : null;
  return raw ? { type: 'office', office: canonicalOffice(raw) } : { type: 'home', office: null };
}

async function createOrder(source: Source, e: ExtractedEmail, issue: JiraIssue, id: string): Promise<OrderState> {
  const reporter = issue.fields.reporter || {};
  const now = new Date().toISOString();
  return {
    id, source: source.name, orderNumber: e.orderNumber, orderDate: e.orderDate, jiraKey: issue.key,
    summary: issue.fields.summary || '',
    requester: {
      name: reporter.displayName || null, email: reporter.emailAddress || null, accountId: reporter.accountId || null,
      slackUserId: await slack.findUserId(reporter.emailAddress || null).catch(() => null),
    },
    delivery: { ...(await deliveryFromIssue(issue)), address: null, country: null },
    billingCompany: null, billingCountry: null, items: [], status: 'Ordered', confirmationSeen: false,
    slack: { masterTs: null }, pendingUserEvents: [], deliveredAt: null, deliveredNotifiedAt: null, lastReminderAt: null,
    escalatedAt: null, serialCandidates: [], receiptConfirmedAt: null,
    finalize: { requested: false, attempts: 0, lastError: null, commented: false, closing: false, ticketClosed: false, closedExternally: false },
    outbox: [], problems: [], open: true, closedAt: null, createdAt: now, updatedAt: now,
  };
}

/** Park an email that has no usable ticket number and ask for it in the master channel. */
async function park(source: Source, e: ExtractedEmail, ref: EmailRef, reason: string): Promise<string> {
  const pending: PendingEmail = { id: ref.id, source: source.name, subject: ref.subject, receivedAt: ref.receivedAt, reason, extracted: e, jiraKey: null, ready: false, slackTs: null };
  const sameOrder = e.orderNumber
    ? (await store.listOpen<PendingEmail>('pending')).find((p) => p.source === source.name && p.extracted.orderNumber === e.orderNumber && p.slackTs)
    : null;
  if (sameOrder) {
    pending.slackTs = sameOrder.slackTs; // one request per order is enough
  } else {
    const m = msg.pendingMessage(pending, await adminMention());
    pending.slackTs = (await slack.post(config.slack.masterChannel, m.text, { blocks: m.blocks })).ts;
  }
  await store.set('pending', pending.id, pending);
  log('warn', `Parked "${ref.subject}": ${reason}`);
  return 'parked';
}

/** Apply the email to the order and send everything that follows from it. */
async function applyAndNotify(order: OrderState, e: ExtractedEmail, ref: EmailRef, source: Source): Promise<void> {
  const change = applyEmail(order, e, ref.receivedAt);
  const auto = await autoSend();
  // In review mode Jira comments stay internal too, so the requester gets no email from Jira either.
  const internal = !config.jira.publicComments || !auto;
  const userFacing = ['order_confirmed', 'shipped', 'delayed', 'delivered'].includes(e.type);

  if (userFacing) {
    await attempt('Jira comment', order, () =>
      jira.addComment(order.jiraKey, msg.jiraUpdateComment(source.name, e, change.touched), internal));
    const f = config.jira.fields;
    const fields: Record<string, unknown> = {};
    if (jira.isConfigured(f.orderStatus)) fields[f.orderStatus] = { value: order.status };
    if (jira.isConfigured(f.orderNumber) && order.orderNumber) fields[f.orderNumber] = order.orderNumber;
    if (Object.keys(fields).length) await attempt('Jira fields', order, () => jira.updateFields(order.jiraKey, fields));
  }

  await attempt('Master channel', order, async () => {
    await syncMaster(order);
    await threadPost(order, msg.masterEvent(e, change.touched, ref.subject));
  });

  if (e.type === 'cancelled' || e.type === 'payment_issue') {
    await alertAdmin(order, `${source.name} reports ${e.type === 'cancelled' ? 'a cancellation' : 'a payment problem'} for order ${order.orderNumber || ''} ("${ref.subject}"). The requester has not been told.`);
    if (source.notifyUserOnCancel) queueForUser(order, msg.userEventLines(e, change.touched, source.name));
  } else if (userFacing) {
    queueForUser(order, msg.userEventLines(e, change.touched, source.name));
  }

  if (e.type === 'delivered' && order.delivery.type === 'office') {
    await attempt('Office channel', order, () => officeNotice(order, change.touched));
  }
  if (change.becameDelivered) {
    await attempt('Jira delivered comment', order, () => jira.addComment(order.jiraKey, msg.jiraDeliveredComment(order), internal));
  }

  const n = config.notifications;
  // Review mode: a preview after every email, so each update in the master channel can be sent right away.
  if (!auto || n.userDmMode === 'perParcel' || (e.type === 'delivered' && n.deliveredImmediately)) {
    await attempt('Requester DM', order, () => flushUser(order));
  }
  await saveOrder(order);
  log('info', `${e.type}: ${change.touched.map((i) => i.name).join(', ') || ref.subject} -> order is ${order.status}`, order.jiraKey);
}

/** Find (or create) the order an email belongs to, then apply it. forcedKey comes from "Link ticket". */
async function routeEmail(e: ExtractedEmail, ref: EmailRef, source: Source, forcedKey?: string): Promise<string> {
  const key = forcedKey || e.jiraKey;
  return withLock(orderIdFor(source.name, e.orderNumber, key), async () => {
    let order = e.orderNumber ? await store.get<OrderState>('orders', orderIdFor(source.name, e.orderNumber, null)) : null;
    if (!order && key) order = await store.get<OrderState>('orders', orderIdFor(source.name, null, key));
    if (!order) {
      if (e.type === 'other') {
        await slack.post(config.slack.masterChannel, `:email: ${source.name} sent an email I don't recognise: "${ref.subject}". Nothing was changed.`);
        return 'other';
      }
      if (!key) return park(source, e, ref, 'No ticket number found in the email');
      const issue = await jira.getIssue(key);
      if (!issue) return park(source, e, ref, `Ticket ${key} was not found in Jira`);
      order = await createOrder(source, e, issue, orderIdFor(source.name, e.orderNumber, key));
    }
    await applyAndNotify(order, e, ref, source);
    return 'applied';
  });
}

/** Check the mailbox for new emails from the allow-listed senders. Called by Cloud Scheduler. */
export async function pollEmails(): Promise<{ applied: number; parked: number; ignored: number; failed: number }> {
  const g = config.gmail;
  const result = { applied: 0, parked: 0, ignored: 0, failed: 0 };
  const ledger = (await store.get<Ledger>('meta', 'emails')) || { ids: {} };
  const cutoff = Date.now() - (g.lookbackDays + 7) * 86_400_000;
  for (const [id, v] of Object.entries(ledger.ids)) if (v.t < cutoff) delete ledger.ids[id];

  for (const source of config.sources) {
    const senders = source.allowedSenders.map((s) => s.toLowerCase());
    const q = `from:(${senders.join(' OR ')}) newer_than:${g.lookbackDays}d`;
    const fresh = (await listMessageIds(q, 300)).filter((id) => !['done', 'failed'].includes(ledger.ids[id]?.s));
    const emails: EmailMessage[] = [];
    for (const id of fresh.slice(-g.maxPerRun)) emails.push(await getMessage(id)); // oldest of the backlog first
    emails.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

    for (const email of emails) {
      const entry = (ledger.ids[email.id] ||= { s: 'retry', n: 0, t: Date.now() });
      if (!senders.includes(email.fromAddress)) { // the search is loose; the allow-list is exact
        entry.s = 'done';
        result.ignored++;
        continue;
      }
      try {
        const outcome = await routeEmail(await extractEmail(email, source.name), email, source);
        entry.s = 'done';
        if (outcome === 'applied') result.applied++; else if (outcome === 'parked') result.parked++; else result.ignored++;
      } catch (err) {
        entry.n++;
        entry.s = entry.n >= g.maxAttempts ? 'failed' : 'retry';
        result.failed++;
        log('error', `Email "${email.subject}" failed (try ${entry.n}): ${errorText(err)}`);
        if (entry.s === 'failed') await alertAdmin(null, `I could not process the ${source.name} email "${email.subject}" after ${entry.n} tries: ${errorText(err)}`);
      }
      await store.set('meta', 'emails', ledger, false);
    }
  }
  await store.set('meta', 'emails', ledger, false);
  return result;
}

/** Process parked emails whose ticket number was supplied from Slack. */
export async function processPending(): Promise<number> {
  const all = (await store.listOpen<PendingEmail>('pending')).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  let done = 0;
  for (const p of all.filter((x) => x.ready && x.jiraKey)) {
    const source = sourceByName(p.source);
    try {
      const outcome = await routeEmail(p.extracted, p, source, p.jiraKey!);
      if (outcome === 'parked') { // the ticket still was not found; routeEmail re-parked it with a new reason
        continue;
      }
      await store.remove('pending', p.id);
      done++;
      // Other parked emails of the same order follow automatically.
      for (const other of all.filter((x) => x.id !== p.id && !x.ready && x.source === p.source && x.extracted.orderNumber && x.extracted.orderNumber === p.extracted.orderNumber)) {
        other.jiraKey = p.jiraKey;
        other.ready = true;
        await store.set('pending', other.id, other);
      }
      if (p.slackTs) await attempt('Pending message', null, () => slack.update(config.slack.masterChannel, p.slackTs!, msg.pendingResolved(p)));
    } catch (err) {
      log('error', `Parked email "${p.subject}" failed: ${errorText(err)}`, p.jiraKey);
    }
  }
  return done ? done + (await processPending()) : 0;
}

/** Dashboard: mark every outstanding item of an order as delivered (when the supplier sent no email). */
export async function markDelivered(orderId: string): Promise<void> {
  await withLock(orderId, async () => {
    const order = await store.get<OrderState>('orders', orderId);
    if (!order) throw new Error('Order not found');
    const items = order.items.filter((i) => i.status !== 'Delivered' && i.status !== 'Cancelled');
    if (!items.length) return;
    const e: ExtractedEmail = {
      type: 'delivered', jiraKey: order.jiraKey, orderNumber: order.orderNumber, orderDate: null, recipientName: null,
      deliveryAddress: null, billingCompany: null, billingCountry: null, deliveryNumber: null, carrier: null, parcelNumber: null,
      trackingUrl: null, shippedDate: null, deliveredAt: null, receivedBy: null,
      items: items.map((i) => ({ name: i.name, manufacturer: i.manufacturer, articleNumber: i.articleNumber, manufacturerPartNumber: i.partNumber, quantity: i.quantity, category: i.category, newDeliveryDate: null, deliveryNote: null })),
    };
    await applyAndNotify(order, e, { id: `manual-${Date.now()}`, subject: 'Marked delivered by IT', receivedAt: new Date().toISOString() }, sourceByName(order.source));
  });
}

/** Dashboard "Test an email": shows what would be read and matched. Writes nothing. */
export async function previewEmail(email: EmailMessage, source: Source) {
  const extracted = await extractEmail(email, source.name);
  const known = extracted.orderNumber ? await store.get<OrderState>('orders', orderIdFor(source.name, extracted.orderNumber, null)) : null;
  const key = known?.jiraKey || extracted.jiraKey;
  const issue = key ? await jira.getIssue(key) : null;
  return {
    extracted,
    ticket: !key ? 'No ticket number found — the email would wait in the master channel for "Link ticket"'
      : !issue ? `${key} not found in Jira — the email would wait in the master channel`
        : {
          key, summary: issue.fields.summary,
          requester: issue.fields.reporter?.displayName || null,
          requesterEmail: issue.fields.reporter?.emailAddress || '(not visible — "Set user" would be needed)',
          delivery: await deliveryFromIssue(issue),
        },
    orderAlreadyTracked: !!known,
  };
}
