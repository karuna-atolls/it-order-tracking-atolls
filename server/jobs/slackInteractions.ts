/**
 * Button clicks and form submissions coming from Slack.
 * Slack needs an answer within 3 seconds, so each handler does the minimum (save, open a form)
 * and returns the slow part as `after`, which runs once Slack has been answered.
 */
import * as jira from '../lib/jira';
import * as slack from '../lib/slack';
import { log } from '../log';
import * as msg from '../messages';
import { store, withLock } from '../store';
import type { OrderState, PendingEmail } from '../types';
import { finalizeOrder, requestFinalize } from './finalize';
import { config } from '../config';
import { errorText } from '../log';
import { attempt, deliverDraft, flushUser, retireDraft, saveOrder, syncMaster, threadPost } from './notify';
import { serialUnits } from './orders';
import { processPending } from './processEmails';

export interface InteractionResult {
  response?: unknown;            // JSON answer for Slack (form errors); empty = OK
  after?: () => Promise<unknown>; // slow work, run after answering
}

const errors = (blockId: string, message: string): InteractionResult => ({ response: { response_action: 'errors', errors: { [blockId]: message } } });

/** Put serial numbers read from the ticket into the matching form fields. */
function prefill(order: OrderState, units: { label: string }[]): (string | undefined)[] {
  const left = [...order.serialCandidates];
  const out: (string | undefined)[] = units.map((u) => {
    const i = left.findIndex((c) => c.device && (u.label.toLowerCase().includes(c.device.toLowerCase()) || c.device.toLowerCase().includes(u.label.toLowerCase())));
    return i >= 0 ? left.splice(i, 1)[0].serial : undefined;
  });
  return out.map((v) => v ?? left.shift()?.serial);
}

/** Only the admin and the configured approvers may release or skip previews. */
async function isApprover(slackUserId: string): Promise<boolean> {
  for (const email of [config.admin.email, ...config.admin.approvers]) {
    if ((await slack.findUserId(email).catch(() => null)) === slackUserId) return true;
  }
  return false;
}

/** "Send" / "Skip" on a preview in the master channel. */
async function draftAction(payload: any, send: boolean): Promise<InteractionResult> {
  const clicker: string = payload.user?.id;
  const [orderId, draftId] = String(payload.actions[0].value).split('::');
  if (!(await isApprover(clicker))) {
    return { after: () => slack.postEphemeral(config.slack.masterChannel, clicker, msg.notApprover) };
  }
  return {
    after: () => withLock(orderId, async () => {
      const o = await store.get<OrderState>('orders', orderId);
      const d = o?.outbox?.find((x) => x.id === draftId);
      if (!o || !d || d.status !== 'waiting') return; // already handled (double click)
      if (!send) {
        await retireDraft(o, d, 'skipped', msg.draftSkipped(d, clicker));
        await saveOrder(o);
        return;
      }
      try {
        const to = await deliverDraft(o, d);
        await retireDraft(o, d, 'sent', msg.draftSent(d, to, clicker));
        log('info', `Preview (${d.kind}) sent to ${to} by ${clicker}`, o.jiraKey);
      } catch (e) {
        await attempt('Master channel', o, () => threadPost(o, msg.draftFailed(errorText(e))));
      }
      await saveOrder(o);
    }),
  };
}

async function blockAction(payload: any): Promise<InteractionResult> {
  const action = payload.actions?.[0];
  const id: string = action?.value;
  const messageRef = { channel: payload.container?.channel_id, ts: payload.container?.message_ts };

  switch (action?.action_id) {
    case 'send_draft':
      return draftAction(payload, true);
    case 'skip_draft':
      return draftAction(payload, false);
    case 'link_ticket': {
      const pending = await store.get<PendingEmail>('pending', id);
      if (pending) await slack.openView(payload.trigger_id, msg.linkTicketView(pending));
      return {};
    }
    case 'set_user': {
      const order = await store.get<OrderState>('orders', id);
      if (order) await slack.openView(payload.trigger_id, msg.setUserView(order));
      return {};
    }
    case 'enter_serials': {
      const order = await store.get<OrderState>('orders', id);
      if (!order || !order.open || order.finalize.requested) return {};
      const units = serialUnits(order);
      await slack.openView(payload.trigger_id, msg.serialsView(order, units, prefill(order, units), { orderId: id, ...messageRef }));
      return {};
    }
    case 'confirm_receipt': {
      const order = await withLock(id, async () => {
        const o = await store.get<OrderState>('orders', id);
        if (!o || !o.open || o.finalize.requested) return null;
        await requestFinalize(o);
        return o;
      });
      if (!order) return {};
      return {
        after: async () => {
          if (messageRef.channel && messageRef.ts) await attempt('Update DM', order, () => slack.update(messageRef.channel, messageRef.ts, msg.thanksDm(order)));
          await finalizeOrder(id);
        },
      };
    }
    default:
      return {};
  }
}

async function viewSubmission(payload: any): Promise<InteractionResult> {
  const view = payload.view;
  const meta = JSON.parse(view.private_metadata || '{}');
  const values = view.state?.values || {};

  switch (view.callback_id) {
    case 'link_ticket_modal': {
      const key = String(values.ticket?.value?.value || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return errors('ticket', msg.ticketErrors.format);
      if (!(await jira.getIssue(key))) return errors('ticket', msg.ticketErrors.missing);
      const pending = await store.get<PendingEmail>('pending', meta.pendingId);
      if (!pending) return {};
      pending.jiraKey = key;
      pending.ready = true;
      await store.set('pending', pending.id, pending);
      log('info', `Ticket linked from Slack by ${payload.user?.name || payload.user?.id}`, key);
      return { after: () => processPending() };
    }
    case 'set_user_modal': {
      const userId: string | undefined = values.user?.value?.selected_user;
      if (!userId) return errors('user', 'Pick a user.');
      return {
        after: () => withLock(meta.orderId, async () => {
          const order = await store.get<OrderState>('orders', meta.orderId);
          if (!order) return;
          order.requester.slackUserId = userId;
          if (order.deliveredAt || order.pendingUserEvents.length) await attempt('Requester DM', order, () => flushUser(order));
          await attempt('Master channel', order, () => syncMaster(order));
          await saveOrder(order);
        }),
      };
    }
    case 'serials_modal': {
      const order = await store.get<OrderState>('orders', meta.orderId);
      if (!order || !order.open || order.finalize.requested) return {};
      const units = serialUnits(order);
      const entered = units.map((_, i) => String(values[`s_${i}`]?.value?.value || '').replace(/\s+/g, '').toUpperCase());
      for (let i = 0; i < entered.length; i++) {
        if (!/^[A-Z0-9-]{4,40}$/.test(entered[i])) return errors(`s_${i}`, msg.serialErrors.format);
        if (entered.indexOf(entered[i]) !== i) return errors(`s_${i}`, msg.serialErrors.duplicate);
      }
      await withLock(order.id, async () => {
        const o = (await store.get<OrderState>('orders', order.id)) || order;
        units.forEach((u, i) => { o.items.find((it) => it.id === u.itemId)!.serials[u.unit] = entered[i]; });
        await requestFinalize(o);
      });
      return {
        after: async () => {
          if (meta.channel && meta.ts) await attempt('Update DM', order, () => slack.update(meta.channel, meta.ts, msg.thanksDm(order)));
          await finalizeOrder(order.id);
        },
      };
    }
    default:
      return {};
  }
}

export async function handleInteraction(payload: any): Promise<InteractionResult> {
  if (payload?.type === 'block_actions') return blockAction(payload);
  if (payload?.type === 'view_submission') return viewSubmission(payload);
  return {};
}
