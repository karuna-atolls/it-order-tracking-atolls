/**
 * Closing an order: once the requester has confirmed receipt (and entered serial numbers where needed),
 * create the Assets objects, comment on the ticket, close it and report in the master channel.
 * Every step is remembered on the order, so a retry never repeats what already worked.
 */
import { config } from '../config';
import * as jira from '../lib/jira';
import { errorText, log } from '../log';
import * as msg from '../messages';
import { store, withLock } from '../store';
import type { OrderState } from '../types';
import { createAsset, forgetEmployee } from './createAssets';
import { alertAdmin, attempt, saveOrder, syncMaster, threadPost } from './notify';
import { categoryOf } from './orders';

const MAX_ATTEMPTS = 3;

export async function finalizeOrder(orderId: string): Promise<void> {
  await withLock(orderId, async () => {
    const order = await store.get<OrderState>('orders', orderId);
    if (!order || !order.open || !order.finalize.requested) return;
    const f = order.finalize;
    try {
      // 1. Assets: one object per delivered device.
      const failures: string[] = [];
      for (const item of order.items) {
        if (item.status !== 'Delivered' || !categoryOf(item).objectType) continue;
        for (let unit = 0; unit < item.quantity; unit++) {
          if (item.assetKeys[unit]) continue;
          const serial = item.serials[unit] || null;
          if (categoryOf(item).needsSerial && !serial) {
            failures.push(`${item.name}: no serial number was provided`);
            continue;
          }
          try {
            item.assetKeys[unit] = await createAsset(order, item, serial);
            await saveOrder(order);
          } catch (e) {
            failures.push(`${item.name}: ${errorText(e)}`);
          }
        }
      }
      // A ticket that IT closed by hand stays closed; anything else waits until the assets are right.
      if (failures.length && !f.closedExternally) throw new Error(`Asset records could not be created — ${failures.join('; ')}`);

      // 2. Ticket comments.
      if (!f.commented) {
        if (!f.closedExternally) await jira.addComment(order.jiraKey, msg.jiraClosingComment(order), false);
        if (order.items.some((i) => i.assetKeys.some(Boolean))) await jira.addComment(order.jiraKey, msg.jiraAssetsComment(order), true);
        f.commented = true;
        await saveOrder(order);
      }

      // 3. Close the ticket.
      if (!f.ticketClosed) {
        f.closing = true; // lets the Jira webhook recognise this as our own closing
        await saveOrder(order);
        const result = await jira.closeTicket(order.jiraKey);
        if (result === 'missing') throw new Error(`The ticket workflow offers no transition to ${config.jira.closeStatuses.join(' / ')}`);
        f.ticketClosed = true;
      }

      // 4. Done: report in the master channel.
      order.open = false;
      order.closedAt = new Date().toISOString();
      f.lastError = null;
      if (failures.length) order.problems.push(`Closed with missing asset records — ${failures.join('; ')}`);
      await saveOrder(order);
      forgetEmployee(order.id);
      await attempt('Master channel', order, async () => {
        await syncMaster(order);
        await threadPost(order, f.closedExternally ? msg.closedByHandMessage(order) : msg.closedMessage(order));
      });
      if (failures.length) await alertAdmin(order, `${order.jiraKey} is closed, but these asset records are missing: ${failures.join('; ')}`);
      log('info', 'Order closed', order.jiraKey);
    } catch (e) {
      f.attempts++;
      f.closing = false;
      f.lastError = errorText(e);
      const firstFailure = f.attempts === 1;
      if (firstFailure) order.problems.push(f.lastError);
      await saveOrder(order);
      if (firstFailure) {
        await attempt('Master channel', order, () => syncMaster(order));
        await alertAdmin(order, `I could not close ${order.jiraKey}: ${f.lastError}. I will retry; you can also press "Retry closing" on the dashboard.`);
      }
    }
  });
}

/** Safety net (runs with every email check): finish orders whose closing was requested but not completed. */
export async function finalizeWaiting(): Promise<number> {
  const waiting = (await store.listOpen<OrderState>('orders')).filter((o) => o.finalize.requested && o.finalize.attempts < MAX_ATTEMPTS);
  for (const o of waiting) await finalizeOrder(o.id);
  return waiting.length;
}

/** The requester confirmed receipt (Slack button or serial form). */
export async function requestFinalize(order: OrderState): Promise<void> {
  order.receiptConfirmedAt ||= new Date().toISOString();
  order.finalize.requested = true;
  order.finalize.attempts = 0;
  await saveOrder(order);
}

/** The ticket was closed in Jira by a person, not by this app. */
export async function handleTicketClosed(jiraKey: string): Promise<string> {
  const orders = (await store.listOpen<OrderState>('orders')).filter((o) => o.jiraKey === jiraKey);
  if (!orders.length) return 'no open order for this ticket';
  for (const order of orders) {
    if (order.finalize.ticketClosed || order.finalize.closing) continue; // our own closing triggered this webhook
    await withLock(order.id, async () => {
      const fresh = await store.get<OrderState>('orders', order.id);
      if (!fresh || !fresh.open || fresh.finalize.ticketClosed || fresh.finalize.closing) return;
      fresh.finalize.requested = true;
      fresh.finalize.closedExternally = true;
      fresh.finalize.ticketClosed = true;
      fresh.finalize.attempts = 0;
      await saveOrder(fresh);
    });
    await finalizeOrder(order.id);
  }
  return 'closed by hand: order finished';
}
