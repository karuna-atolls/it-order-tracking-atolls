/** Scheduled jobs for the requester: the daily digest and the "please confirm" reminders. */
import { config } from '../config';
import * as jira from '../lib/jira';
import * as msg from '../messages';
import { store, withLock } from '../store';
import type { OrderState } from '../types';
import { handleTicketClosed } from './finalize';
import { adminMention, attempt, flushUser, saveOrder, sendOrDraft, syncMaster, threadPost } from './notify';

/** Whole calendar days between two moments, in the configured time zone. */
function daysBetween(fromIso: string, to: Date): number {
  const day = (d: Date) => Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d));
  return Math.round((day(to) - day(new Date(fromIso))) / 86_400_000);
}

/** Send each requester one DM with everything that happened since their last one. */
export async function sendDigests(): Promise<{ sent: number; waitingForUser: number }> {
  const result = { sent: 0, waitingForUser: 0 };
  for (const listed of await store.listOpen<OrderState>('orders')) {
    await withLock(listed.id, async () => {
      const o = await store.get<OrderState>('orders', listed.id);
      if (!o || !o.open) return;
      const due = o.pendingUserEvents.length > 0 || (!!o.deliveredAt && !o.receiptConfirmedAt && !o.deliveredNotifiedAt);
      if (!due) return;
      const hadUser = !!o.requester.slackUserId;
      let sent = false;
      await attempt('Requester DM', o, async () => { sent = await flushUser(o); });
      if (sent) result.sent++;
      else if (!o.requester.slackUserId) result.waitingForUser++; // otherwise a preview is already waiting for approval
      if (!o.requester.slackUserId || !hadUser) await attempt('Master channel', o, () => syncMaster(o)); // shows / hides "Set user"
      await saveOrder(o);
    });
  }
  return result;
}

/** After delivery: remind every N days until the ticket is closed; tag the admin when it drags on. */
export async function sendReminders(): Promise<{ reminded: number; escalated: number; closed: number }> {
  const result = { reminded: 0, escalated: 0, closed: 0 };
  const now = new Date();
  const waiting = (await store.listOpen<OrderState>('orders')).filter((o) => o.deliveredNotifiedAt && !o.receiptConfirmedAt);
  for (const listed of waiting) {
    // The ticket may have been closed in Jira without the webhook reaching us.
    const issue = await jira.getIssue(listed.jiraKey).catch(() => null);
    if (issue && jira.isDone(issue)) {
      await handleTicketClosed(listed.jiraKey);
      result.closed++;
      continue;
    }
    await withLock(listed.id, async () => {
      const o = await store.get<OrderState>('orders', listed.id);
      if (!o || !o.open || o.receiptConfirmedAt || !o.deliveredNotifiedAt) return;
      if (o.requester.slackUserId && daysBetween(o.lastReminderAt || o.deliveredNotifiedAt, now) >= config.reminders.everyDays) {
        const dm = msg.reminderDm(o);
        let outcome = 'skipped';
        await attempt('Reminder DM', o, async () => {
          outcome = await sendOrDraft(o, { kind: 'reminder', target: 'user', channel: null, events: [], receipt: false, ...dm });
        });
        if (outcome !== 'skipped') result.reminded++;
      }
      if (!o.escalatedAt && daysBetween(o.deliveredNotifiedAt, now) >= config.reminders.escalateAfterDays) {
        const mention = await adminMention();
        if (await attempt('Escalation', o, () => threadPost(o, msg.escalation(o, mention, config.reminders.escalateAfterDays)))) {
          o.escalatedAt = now.toISOString();
          result.escalated++;
        }
      }
      await saveOrder(o);
    });
  }
  return result;
}
