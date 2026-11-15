/**
 * Every text the app sends: Slack (master channel, office channels, DMs, forms) and Jira comments.
 * Edit wording or translate here. Slack uses mrkdwn (*bold*, <url|label>); Jira uses wiki markup (*bold*, [label|url]).
 */
import { config } from './config';
import { deliveredCount, serialUnits } from './jobs/orders';
import { ticketUrl } from './lib/jira';
import { actions, button, section } from './lib/slack';
import type { Draft, ExtractedEmail, ItemState, ItemStatus, OrderState, PendingEmail } from './types';

const ICON: Record<ItemStatus, string> = {
  Ordered: ':clock3:', Shipped: ':truck:', Delayed: ':hourglass_flowing_sand:', Delivered: ':white_check_mark:', Cancelled: ':x:',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-17 12:40" -> "17 Oct 12:40"; ISO timestamps are shown in the configured time zone. */
export function fmtDate(v: string | null): string {
  if (!v) return '';
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: config.timezone }).format(new Date(v));
  }
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : v;
}

const qty = (i: ItemState) => (i.quantity > 1 ? `${i.quantity}x ` : '');
const firstName = (o: OrderState) => (o.requester.name || '').split(' ')[0] || 'there';
const ticket = (o: OrderState) => `<${ticketUrl(o.jiraKey)}|${o.jiraKey}>`;
const who = (o: OrderState) => (o.requester.slackUserId ? `<@${o.requester.slackUserId}>` : o.requester.name || 'the requester');
const where = (o: OrderState) => (o.delivery.type === 'office' ? `${o.delivery.office} office` : 'home address');

function itemDetail(i: ItemState, slack: boolean): string {
  const link = (url: string, label: string) => (slack ? `<${url}|${label}>` : `[${label}|${url}]`);
  switch (i.status) {
    case 'Shipped': {
      const tracking = i.trackingUrl ? link(i.trackingUrl, i.parcelNumber || 'track it') : i.parcelNumber || '';
      return `shipped${i.carrier ? ` with ${i.carrier}` : ''}${tracking ? ` — ${tracking}` : ''}`;
    }
    case 'Delayed': return `delayed${!i.expected ? '' : /^\d{4}-\d{2}-\d{2}/.test(i.expected) ? ` — new date: ${fmtDate(i.expected)}` : ` — ${i.expected}`}`;
    case 'Delivered': return `delivered${i.deliveredAt ? ` ${fmtDate(i.deliveredAt)}` : ''}${i.receivedBy ? ` (received by ${i.receivedBy})` : ''}`;
    case 'Cancelled': return 'cancelled';
    default: return 'ordered';
  }
}

export const itemLine = (i: ItemState) => `${ICON[i.status]} ${qty(i)}${i.name} — ${itemDetail(i, true)}`;

// ---------------------------------------------------------------- master channel

/** The always-current summary at the top of each order's thread in the master channel. */
export function masterMessage(o: OrderState): { text: string; blocks: unknown[] } {
  const c = deliveredCount(o);
  const text = [
    `:package: *${o.source} order ${o.orderNumber || '(no number)'}* — ${ticket(o)} ${o.summary}`,
    `Requester: ${who(o)}${o.requester.slackUserId && o.requester.name ? ` (${o.requester.name})` : ''} · Delivery: ${where(o)}`,
    `Status: *${o.open ? o.status : 'Closed'}* (${c.delivered} of ${c.total} delivered)`,
    ...o.items.map(itemLine),
    ...(o.problems.length ? [`:warning: ${o.problems[o.problems.length - 1]}`] : []),
  ].join('\n');
  const blocks: unknown[] = [section(text)];
  if (o.open && !o.requester.slackUserId) {
    blocks.push(section(':warning: I could not find this requester in Slack, so they are not being notified yet.'));
    blocks.push(actions(button('Set user', 'set_user', o.id, true)));
  }
  return { text, blocks };
}

const TITLES: Record<string, string> = {
  order_confirmed: ':memo: *Order confirmed*', shipped: ':truck: *Shipped*', delayed: ':hourglass_flowing_sand: *Delivery date changed*',
  delivered: ':white_check_mark: *Delivered*', cancelled: ':x: *Cancelled*', payment_issue: ':credit_card: *Payment problem*', other: ':email: *Other email*',
};

/** Thread reply in the master channel for each supplier email. */
export function masterEvent(e: ExtractedEmail, touched: ItemState[], subject: string): string {
  const extra = [e.deliveryNumber ? `delivery ${e.deliveryNumber}` : null, e.carrier, e.parcelNumber].filter(Boolean).join(' · ');
  return [
    `${TITLES[e.type]}${extra ? ` (${extra})` : ''}`,
    ...touched.map(itemLine),
    ...(e.type === 'other' ? [`Subject: ${subject}`] : []),
  ].join('\n');
}

export function pendingMessage(p: PendingEmail, adminMention: string): { text: string; blocks: unknown[] } {
  const e = p.extracted;
  const text = [
    `:warning: ${adminMention} *${p.source} email needs a ticket number*`,
    `*Reason:* ${p.reason}`,
    `*Subject:* ${p.subject}`,
    e.orderNumber ? `*Order:* ${e.orderNumber}` : null,
    e.recipientName ? `*For:* ${e.recipientName}` : null,
    e.items.length ? `*Items:* ${e.items.map((i) => i.name).join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return { text, blocks: [section(text), actions(button('Link ticket', 'link_ticket', p.id, true))] };
}

export const pendingResolved = (p: PendingEmail) => `:white_check_mark: ${p.source} email "${p.subject}" linked to ${p.jiraKey}.`;

export const adminAlert = (adminMention: string, text: string) => `:rotating_light: ${adminMention} ${text}`;

export const closedMessage = (o: OrderState) => [
  `:white_check_mark: *${o.jiraKey} closed successfully.* ${o.requester.name || 'The requester'} confirmed receipt.`,
  ...o.items.filter((i) => i.assetKeys.some(Boolean)).map((i) => `• ${i.name}: ${i.assetKeys.filter(Boolean).join(', ')}${i.serials.filter(Boolean).length ? ` (SN ${i.serials.filter(Boolean).join(', ')})` : ''}`),
].join('\n');

export const closedByHandMessage = (o: OrderState) => [
  `:information_source: *${o.jiraKey} was closed in Jira.* Order tracking and reminders have stopped.`,
  ...o.items.filter((i) => i.assetKeys.some(Boolean)).map((i) => `• ${i.name}: ${i.assetKeys.filter(Boolean).join(', ')}`),
].join('\n');

export const escalation = (o: OrderState, adminMention: string, days: number) =>
  `:rotating_light: ${adminMention} ${who(o)} has not confirmed receipt for ${ticket(o)} for more than ${days} days.`;

// ---------------------------------------------------------------- office channel

export const officeNotice = (o: OrderState, touched: ItemState[]) => [
  `:package: A parcel for ${who(o)}${o.requester.slackUserId && o.requester.name ? ` (${o.requester.name})` : ''} has arrived at the ${o.delivery.office} office.`,
  ...touched.map((i) => `• ${qty(i)}${i.name}`),
  `Ticket: ${ticket(o)}`,
].join('\n');

// ---------------------------------------------------------------- requester DMs

/** One line per item for the requester's next DM. key = which earlier line it replaces. */
export function userEventLines(e: ExtractedEmail, touched: ItemState[], source: string): { key: string; line: string }[] {
  if (e.type === 'order_confirmed') {
    return [{ key: 'order', line: `:memo: Your order was placed with ${source}: ${touched.map((i) => `${qty(i)}${i.name}`).join(', ')}` }];
  }
  return touched.map((i) => ({ key: i.id, line: `${ICON[i.status]} *${qty(i)}${i.name}* — ${itemDetail(i, true)}` }));
}

function receiptRequest(o: OrderState): { text: string; blocks: unknown[] } {
  const units = serialUnits(o);
  const place = o.delivery.type === 'office' ? ` to the ${o.delivery.office} office — please collect it there` : '';
  const text = units.length
    ? `:tada: Everything in your order has been delivered${place}.\nTo finish, please send the serial number of: ${units.map((u) => `*${u.label}*`).join(', ')}.\nUse the button below, or add the serial number (or a photo of the label) as a comment on the ticket.`
    : `:tada: Everything in your order has been delivered${place}.\nPlease confirm that you have received it so the ticket can be closed.`;
  return {
    text,
    blocks: [section(text), actions(units.length
      ? button(units.length > 1 ? 'Enter serial numbers' : 'Enter serial number', 'enter_serials', o.id, true)
      : button('Confirm receipt', 'confirm_receipt', o.id, true))],
  };
}

/** The DM that carries queued updates, plus the receipt request once everything is delivered. */
export function userDm(o: OrderState, lines: string[]): { text: string; blocks: unknown[] } {
  const c = deliveredCount(o);
  const head = `Hi ${firstName(o)}, here is the latest on your IT order (${ticket(o)}):`;
  const body = [head, ...lines, `_${c.delivered} of ${c.total} items delivered._`].join('\n');
  const blocks: unknown[] = [section(body)];
  let text = body;
  if (o.deliveredAt && !o.receiptConfirmedAt) {
    const r = receiptRequest(o);
    text += `\n${r.text}`;
    blocks.push(...r.blocks);
  }
  return { text, blocks };
}

export function reminderDm(o: OrderState): { text: string; blocks: unknown[] } {
  const r = receiptRequest(o);
  const text = `:bell: Reminder for your IT order (${ticket(o)}), delivered ${fmtDate(o.deliveredAt)}.\n${r.text.replace(':tada: ', '')}`;
  return { text, blocks: [section(text), r.blocks[1]] };
}

export const serialCandidatesDm = (o: OrderState): { text: string; blocks: unknown[] } => {
  const text = `I found ${o.serialCandidates.length > 1 ? 'these serial numbers' : 'this serial number'} on your ticket ${ticket(o)}: ${o.serialCandidates.map((c) => `*${c.serial}*`).join(', ')}.\nPlease check and confirm.`;
  return { text, blocks: [section(text), actions(button('Review and confirm', 'enter_serials', o.id, true))] };
};

export const thanksDm = (o: OrderState) => `:white_check_mark: Thank you! Receipt confirmed for ${ticket(o)}. The ticket will now be closed.`;

// ---------------------------------------------------------------- Jira comments (wiki markup)

export function jiraUpdateComment(source: string, e: ExtractedEmail, touched: ItemState[]): string {
  const title: Record<string, string> = {
    order_confirmed: 'Order confirmed', shipped: 'Shipped', delayed: 'Delivery date changed', delivered: 'Delivered',
    cancelled: 'Cancelled', payment_issue: 'Payment problem', other: 'Update',
  };
  return [
    `*${source} order ${e.orderNumber || ''}: ${title[e.type]}*`,
    ...touched.map((i) => `* ${qty(i)}${i.name} — ${itemDetail(i, false)}`),
  ].join('\n');
}

export function jiraDeliveredComment(o: OrderState): string {
  const units = serialUnits(o);
  return units.length
    ? `All items in this order have been delivered. Please reply with the serial number (or a photo of the label) of: ${units.map((u) => u.label).join(', ')}.`
    : 'All items in this order have been delivered. Please confirm that you have received everything.';
}

export function jiraClosingComment(o: OrderState): string {
  const serials = o.items.filter((i) => i.serials.some(Boolean)).map((i) => `* ${i.name}: ${i.serials.filter(Boolean).join(', ')}`);
  return ['Receipt confirmed. Thank you!', ...(serials.length ? ['Serial numbers:', ...serials] : []), 'This ticket is now closed.'].join('\n');
}

export const jiraAssetsComment = (o: OrderState) =>
  ['*Asset records created*', ...o.items.filter((i) => i.assetKeys.some(Boolean)).map((i) => `* ${i.name}: ${i.assetKeys.filter(Boolean).join(', ')}`)].join('\n');

// ---------------------------------------------------------------- Slack forms (modals)

const modal = (callbackId: string, title: string, submit: string, meta: unknown, blocks: unknown[]) => ({
  type: 'modal', callback_id: callbackId, private_metadata: JSON.stringify(meta),
  title: { type: 'plain_text', text: title }, submit: { type: 'plain_text', text: submit }, close: { type: 'plain_text', text: 'Cancel' }, blocks,
});

const textInput = (blockId: string, label: string, placeholder: string, initial?: string) => ({
  type: 'input', block_id: blockId, label: { type: 'plain_text', text: label.slice(0, 150) },
  element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: placeholder }, ...(initial ? { initial_value: initial } : {}) },
});

export const linkTicketView = (p: PendingEmail) => modal('link_ticket_modal', 'Link ticket', 'Link', { pendingId: p.id }, [
  section(`*${p.source}* email: ${p.subject}${p.extracted.orderNumber ? `\nOrder ${p.extracted.orderNumber}` : ''}`),
  textInput('ticket', 'Jira ticket number', `${config.jira.projectKey}-12345`),
]);

export const setUserView = (o: OrderState) => modal('set_user_modal', 'Set user', 'Save', { orderId: o.id }, [
  section(`Who should be notified about ${o.jiraKey}${o.requester.name ? ` (${o.requester.name})` : ''}?`),
  { type: 'input', block_id: 'user', label: { type: 'plain_text', text: 'Slack user' }, element: { type: 'users_select', action_id: 'value' } },
]);

export const serialsView = (o: OrderState, units: { label: string }[], prefill: (string | undefined)[], meta: unknown) =>
  modal('serials_modal', 'Serial numbers', 'Confirm', meta, [
    section(`Please enter the serial number printed on the device or its box (often marked *S/N*). This also confirms that you received your order ${o.jiraKey}.`),
    ...units.map((u, i) => textInput(`s_${i}`, u.label, 'Serial number', prefill[i])),
  ]);

export const serialErrors = { format: 'This does not look like a serial number (letters, digits and dashes only).', duplicate: 'The same serial number was entered twice.' };
export const ticketErrors = { format: `Enter a ticket number like ${config.jira.projectKey}-12345.`, missing: 'This ticket was not found in Jira.' };

// ---------------------------------------------------------------- review mode (previews in the master channel)

const KIND_LABEL: Record<Draft['kind'], string> = {
  update: 'Order update', reminder: 'Reminder', office: 'Office notice', serials: 'Serial number check',
};

const recipient = (o: OrderState, d: Pick<Draft, 'target' | 'channel'>) =>
  d.target === 'office' ? `#${d.channel}` : o.requester.slackUserId ? `<@${o.requester.slackUserId}>` : `${o.requester.name || 'the requester'} (not found in Slack — use "Set user" first)`;

const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');

export function draftPreview(o: OrderState, d: Draft): { text: string; blocks: unknown[] } {
  const head = `:eyes: *${KIND_LABEL[d.kind]} — not sent yet.* To: ${recipient(o, d)}${d.receipt ? ' · includes the request to confirm receipt' : ''}`;
  const sendLabel = d.target === 'office' ? `Send to #${d.channel}` : `Send to ${(o.requester.name || 'user').split(' ')[0]}`;
  return {
    text: `${head}\n${quote(d.text)}`,
    blocks: [
      section(head),
      section(quote(d.text)),
      actions(button(sendLabel.slice(0, 70), 'send_draft', `${o.id}::${d.id}`, true), button('Skip', 'skip_draft', `${o.id}::${d.id}`)),
    ],
  };
}

export const draftSent = (d: Draft, to: string, by: string) => `:white_check_mark: ${KIND_LABEL[d.kind]} sent to ${to} by <@${by}>.\n${quote(d.text)}`;
export const draftSkipped = (d: Draft, by: string) => `:no_entry_sign: ${KIND_LABEL[d.kind]} skipped by <@${by}> — not sent.\n${quote(d.text)}`;
export const draftReplaced = (d: Draft) => `:arrows_counterclockwise: ${KIND_LABEL[d.kind]} replaced by a newer preview below (it includes these lines).`;
export const draftFailed = (error: string) => `:warning: Could not send: ${error}`;
export const notApprover = 'Only IT admins can send or skip previews. Ask an admin to check this message.';
