/** Slack + Jira notifications that several jobs share. */
import { config } from '../config';
import * as jira from '../lib/jira';
import * as slack from '../lib/slack';
import { errorText, log } from '../log';
import * as msg from '../messages';
import { store } from '../store';
import { autoSend } from '../settings';
import type { Draft, ItemState, OrderState } from '../types';

export async function saveOrder(o: OrderState): Promise<void> {
  o.updatedAt = new Date().toISOString();
  await store.set('orders', o.id, o, o.open);
}

/** Run a notification step; a failure is logged but never stops the order from being saved. */
export async function attempt(label: string, o: OrderState | null, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    log('error', `${label}: ${errorText(e)}`, o?.jiraKey);
    return false;
  }
}

/** "<@U123>" for the admin, so they are tagged in Slack. */
export async function adminMention(): Promise<string> {
  const id = await slack.findUserId(config.admin.email).catch(() => null);
  return id ? `<@${id}>` : 'IT admin';
}

/** Create or refresh the order's summary message in the master channel. */
export async function syncMaster(o: OrderState): Promise<void> {
  const m = msg.masterMessage(o);
  if (o.slack.masterTs) {
    await slack.update(config.slack.masterChannel, o.slack.masterTs, m.text, m.blocks);
  } else {
    o.slack.masterTs = (await slack.post(config.slack.masterChannel, m.text, { blocks: m.blocks })).ts;
  }
}

export async function threadPost(o: OrderState, text: string): Promise<void> {
  if (!o.slack.masterTs) await syncMaster(o);
  await slack.post(config.slack.masterChannel, text, { threadTs: o.slack.masterTs });
}

/** Tag the admin in the master channel and, when there is a ticket, in an internal Jira comment. */
export async function alertAdmin(o: OrderState | null, text: string): Promise<void> {
  log('warn', text, o?.jiraKey);
  await attempt('Admin alert (Slack)', o, async () => {
    const alert = msg.adminAlert(await adminMention(), text);
    if (o) await threadPost(o, alert); else await slack.post(config.slack.masterChannel, alert);
  });
  if (o) {
    await attempt('Admin alert (Jira)', o, async () => {
      const accountId = await jira.findAccountId(config.admin.email);
      await jira.addComment(o.jiraKey, `${accountId ? `${jira.mention(accountId)} ` : ''}${text}`, true);
    });
  }
}

/** Queue lines for the requester's next DM; a newer line about the same item replaces the older one. */
export function queueForUser(o: OrderState, events: { key: string; line: string }[]): void {
  for (const e of events) {
    o.pendingUserEvents = o.pendingUserEvents.filter((x) => x.key !== e.key);
    o.pendingUserEvents.push(e);
  }
}

// ---------------------------------------------------------------- the send gate (review mode)

type NewDraft = Pick<Draft, 'kind' | 'target' | 'channel' | 'events' | 'receipt' | 'text' | 'blocks'>;

const waiting = (o: OrderState, kind: Draft['kind']) => (o.outbox ||= []).find((d) => d.kind === kind && d.status === 'waiting');

/** Actually send a message and apply what sending means (receipt requested, reminder sent). */
export async function deliverDraft(o: OrderState, d: Pick<Draft, 'target' | 'channel' | 'text' | 'blocks' | 'receipt' | 'kind'>): Promise<string> {
  let to: string;
  if (d.target === 'user') {
    o.requester.slackUserId ||= await slack.findUserId(o.requester.email);
    if (!o.requester.slackUserId) throw new Error('the requester was not found in Slack — use "Set user" on the order message first');
    to = o.requester.slackUserId;
  } else {
    if (!d.channel) throw new Error('no office channel');
    to = d.channel;
  }
  await slack.post(to, d.text, { blocks: d.blocks });
  const now = new Date().toISOString();
  if (d.receipt && !o.deliveredNotifiedAt) {
    o.deliveredNotifiedAt = now;
    o.lastReminderAt = now;
  }
  if (d.kind === 'reminder') o.lastReminderAt = now;
  return d.target === 'user' ? `<@${to}>` : `#${to}`;
}

/** The preview shown in the master channel for a message waiting for approval. */
async function postPreview(o: OrderState, d: Draft): Promise<void> {
  const p = msg.draftPreview(o, d);
  if (!o.slack.masterTs) await syncMaster(o);
  d.previewTs = (await slack.post(config.slack.masterChannel, p.text, { blocks: p.blocks, threadTs: o.slack.masterTs })).ts;
}

async function addDraft(o: OrderState, nd: NewDraft): Promise<'drafted'> {
  const d: Draft = { ...nd, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, status: 'waiting', previewTs: null, createdAt: new Date().toISOString() };
  o.outbox.push(d);
  await postPreview(o, d);
  return 'drafted';
}

/** Send now (automatic sending on) or put it up for approval in the master channel (review mode). */
export async function sendOrDraft(o: OrderState, nd: NewDraft): Promise<'sent' | 'drafted' | 'skipped'> {
  if (await autoSend()) {
    await deliverDraft(o, nd);
    return 'sent';
  }
  if (waiting(o, nd.kind)) return 'skipped'; // one waiting preview of each kind is enough
  return addDraft(o, nd);
}

/** Mark a waiting preview as no longer needed and update its message. */
export async function retireDraft(o: OrderState, d: Draft, status: 'sent' | 'skipped' | 'replaced', note: string): Promise<void> {
  d.status = status;
  if (d.previewTs) await attempt('Preview message', o, () => slack.update(config.slack.masterChannel, d.previewTs!, note, [slack.section(note)]));
}

/**
 * Send the requester everything that is waiting for them in one DM (or, in review mode, one preview).
 * Returns false when there was nothing to send, or the requester cannot be found in Slack yet.
 */
export async function flushUser(o: OrderState): Promise<boolean> {
  const receiptDue = !!o.deliveredAt && !o.receiptConfirmedAt && !o.deliveredNotifiedAt;
  if (!o.pendingUserEvents.length && !receiptDue) return false;

  if (await autoSend()) {
    o.requester.slackUserId ||= await slack.findUserId(o.requester.email);
    if (!o.requester.slackUserId) return false;
    const dm = msg.userDm(o, o.pendingUserEvents.map((e) => e.line));
    await deliverDraft(o, { kind: 'update', target: 'user', channel: null, receipt: receiptDue, ...dm });
    o.pendingUserEvents = [];
    return true;
  }

  // Review mode: one preview carries everything not sent yet; a newer one replaces the older one.
  const old = waiting(o, 'update');
  if (old && !o.pendingUserEvents.length && old.receipt === receiptDue) return false;
  const events = [...(old?.events || [])];
  for (const e of o.pendingUserEvents) {
    const i = events.findIndex((x) => x.key === e.key);
    if (i >= 0) events.splice(i, 1);
    events.push(e);
  }
  if (old) await retireDraft(o, old, 'replaced', msg.draftReplaced(old));
  const dm = msg.userDm(o, events.map((e) => e.line));
  await addDraft(o, { kind: 'update', target: 'user', channel: null, events, receipt: receiptDue, ...dm });
  o.pendingUserEvents = [];
  return true;
}

/** Office deliveries: tell the office's channel that a parcel has arrived. */
export async function officeNotice(o: OrderState, touched: ItemState[]): Promise<void> {
  const channel = o.delivery.office ? config.slack.officeChannels[o.delivery.office] : null;
  if (!channel) {
    await alertAdmin(o, `No Slack channel is configured for the "${o.delivery.office}" office, so the office was not notified.`);
    return;
  }
  // Each parcel gets its own office notice, so office previews are never merged or skipped.
  if (await autoSend()) await deliverDraft(o, { kind: 'office', target: 'office', channel, receipt: false, text: msg.officeNotice(o, touched), blocks: [] });
  else await addDraft(o, { kind: 'office', target: 'office', channel, events: [], receipt: false, text: msg.officeNotice(o, touched), blocks: [] });
}
