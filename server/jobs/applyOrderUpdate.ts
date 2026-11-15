/**
 * The core of the app: one order update -> Jira field + comment + transition -> Slack DM -> asset records.
 * Used for supplier emails and for "Mark delivered" from the dashboard.
 */
import { config } from '../config';
import { addComment, orderStatusOf, requesterEmail, ticketUrl, transitionTo, updateFields } from '../lib/jira';
import { notifyRequester } from '../lib/slack';
import { log } from '../log';
import { jiraComment, statusDm } from '../messages';
import type { JiraIssue, OrderUpdate, ProcessOutcome } from '../types';
import { createAssetsForDelivery } from './createAssets';

/** Same status already on the ticket -> already notified (partial deliveries can repeat). */
export function isRepeat(issue: JiraIssue, u: OrderUpdate): boolean {
  return orderStatusOf(issue) === u.status && u.status !== 'Partially delivered';
}

export function plan(issue: JiraIssue, u: OrderUpdate): string[] {
  const target = config.jira.transitionOnStatus[u.status];
  return [
    `Set "Order status" on ${issue.key} to ${u.status}`,
    'Add a Jira comment with the order details',
    target ? `Move ${issue.key} to "${target}"` : 'No status change on the ticket',
    `DM the requester (${requesterEmail(issue) || 'email not visible — falls back to IT channel'})`,
    ['Delivered', 'Partially delivered'].includes(u.status) && u.items.length
      ? `Create asset records for ${u.items.length} order line(s)` : 'No asset records',
  ];
}

export async function applyOrderUpdate(issue: JiraIssue, u: OrderUpdate, source: string, emailSubject?: string): Promise<ProcessOutcome> {
  const key = issue.key;
  const f = config.jira.fields;

  const fields: Record<string, unknown> = { [f.orderStatus]: { value: u.status } };
  if (f.orderNumber && u.orderNumber) fields[f.orderNumber] = u.orderNumber;
  if (f.trackingUrl && u.trackingUrl) fields[f.trackingUrl] = u.trackingUrl;
  await updateFields(key, fields);
  await addComment(key, jiraComment(source, u, emailSubject));

  const target = config.jira.transitionOnStatus[u.status];
  let transition = 'none';
  if (target) {
    transition = await transitionTo(key, issue.fields.status?.name, target);
    if (transition === 'missing') log('warn', `No transition to "${target}" available`, key);
  }

  const ctx = { jiraKey: key, summary: issue.fields.summary, ticketUrl: ticketUrl(key) };
  const notified = await notifyRequester(requesterEmail(issue), key, statusDm(u.status, ctx, u));

  let assetsCreated = 0;
  if (['Delivered', 'Partially delivered'].includes(u.status) && u.items.length) {
    assetsCreated = await createAssetsForDelivery({
      jiraKey: key,
      orderNumber: u.orderNumber,
      reporterAccountId: issue.fields.reporter?.accountId || null,
      items: u.items,
    });
  }

  log('info', `${u.status}: ticket updated, requester notified by ${notified}`, key);
  return { outcome: 'processed', jiraKey: key, status: u.status, notified, transition, assetsCreated };
}
