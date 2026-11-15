/**
 * Jira webhook (events: issue updated, comment created).
 * - Ticket closed by a person -> finish the order.
 * - The requester adds a comment or a photo after delivery -> read the serial number from it.
 */
import { config } from '../config';
import { readSerials } from '../lib/gemini';
import * as jira from '../lib/jira';
import { log } from '../log';
import * as msg from '../messages';
import { store, withLock } from '../store';
import type { OrderState } from '../types';
import { handleTicketClosed } from './finalize';
import { attempt, saveOrder, sendOrDraft, threadPost } from './notify';
import { missingSerials } from './orders';

/** Comment bodies arrive as plain text or as Atlassian Document Format. */
function plainText(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body.text === 'string') return body.text;
  return Array.isArray(body.content) ? body.content.map(plainText).join(' ') : '';
}

async function serialsFromTicket(jiraKey: string, authorId: string | undefined, text: string, attachmentIds: string[]): Promise<string> {
  const order = (await store.listOpen<OrderState>('orders')).find((o) => o.jiraKey === jiraKey && o.deliveredAt && !o.receiptConfirmedAt);
  if (!order) return 'no order is waiting for serial numbers on this ticket';
  const missing = missingSerials(order);
  if (!missing.length) return 'no serial numbers needed';
  if (order.requester.accountId && authorId !== order.requester.accountId) return 'not from the requester';

  const images = [];
  for (const id of attachmentIds.slice(0, 3)) {
    const image = await jira.getImageAttachment(id).catch(() => null);
    if (image) images.push(image);
  }
  if (!images.length && !/[A-Z0-9-]{5,}/i.test(text)) return 'nothing that looks like a serial number';

  const found = await readSerials(text, images, missing.map((u) => u.label));
  if (!found.length) return 'no serial number found';

  await withLock(order.id, async () => {
    const o = (await store.get<OrderState>('orders', order.id)) || order;
    for (const f of found) if (!o.serialCandidates.some((c) => c.serial === f.serial)) o.serialCandidates.push(f);
    await saveOrder(o);
    // Reading can go wrong, so the requester confirms what was read before it is used.
    if (o.requester.slackUserId) {
      const dm = msg.serialCandidatesDm(o);
      await attempt('Serial confirmation DM', o, () => sendOrDraft(o, { kind: 'serials', target: 'user', channel: null, events: [], receipt: false, ...dm }));
      await saveOrder(o);
    } else {
      await attempt('Master channel', o, () => threadPost(o, `Serial number(s) read from the ticket: ${found.map((f) => f.serial).join(', ')} — the requester is not in Slack, so nobody could confirm them.`));
    }
  });
  log('info', `Read ${found.length} serial number(s) from the ticket`, jiraKey);
  return `found ${found.length} serial number(s)`;
}

export async function handleJiraWebhook(body: any): Promise<string> {
  const key: string | undefined = body?.issue?.key;
  if (!key) return 'ignored: no issue';

  if (body.webhookEvent === 'comment_created') {
    return serialsFromTicket(key, body.comment?.author?.accountId, plainText(body.comment?.body), []);
  }
  const changes: any[] = body?.changelog?.items || [];
  const status = changes.find((c) => c.field === 'status');
  if (status) {
    const closed = config.jira.closeStatuses.some((s) => s.toLowerCase() === String(status.toString || '').toLowerCase())
      || body.issue?.fields?.status?.statusCategory?.key === 'done';
    return closed ? handleTicketClosed(key) : 'ignored: not a closing status';
  }
  const attachments = changes.filter((c) => c.field === 'Attachment' && c.to).map((c) => String(c.to));
  if (attachments.length) return serialsFromTicket(key, body.user?.accountId, '', attachments);
  return 'ignored';
}
