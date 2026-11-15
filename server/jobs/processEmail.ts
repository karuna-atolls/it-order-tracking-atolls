import { config } from '../config';
import { extractOrder } from '../lib/gemini';
import { addLabel, getMessage, listMessageIds } from '../lib/gmail';
import { getIssue } from '../lib/jira';
import { postToItChannel } from '../lib/slack';
import { log } from '../log';
import { errorAlert, unmatchedAlert } from '../messages';
import type { EmailMessage, ProcessOutcome, Source } from '../types';
import { applyOrderUpdate, isRepeat, plan } from './applyOrderUpdate';

/** Process one supplier email. With dryRun, nothing is written anywhere. */
export async function processOrderEmail(email: EmailMessage, source: Source, dryRun = false): Promise<ProcessOutcome> {
  const update = await extractOrder(email, source.name);

  let reason: string | null = null;
  const issue = update.jiraKey ? await getIssue(update.jiraKey) : null;
  if (!update.jiraKey) reason = 'No Jira ticket key found in the email';
  else if (!issue) reason = `Jira ticket ${update.jiraKey} not found (or no access)`;
  else if (update.status === 'Unknown') reason = 'Could not work out the order status';

  if (reason || !issue) {
    if (!dryRun) {
      await postToItChannel(unmatchedAlert(source.name, email.subject, reason!, update));
      log('warn', `Unmatched email "${email.subject}": ${reason}`);
    }
    return { outcome: 'unmatched', reason: reason!, update };
  }
  if (isRepeat(issue, update)) {
    return { outcome: 'skipped', jiraKey: issue.key, reason: `Order status is already ${update.status}` };
  }
  if (dryRun) return { outcome: 'dry-run', jiraKey: issue.key, update, plan: plan(issue, update) };
  return applyOrderUpdate(issue, update, source.name, email.subject);
}

/** Check every source mailbox query for new emails. Called by Cloud Scheduler. */
export async function pollGmail(): Promise<{ processed: number; failed: number }> {
  const g = config.gmail;
  let processed = 0;
  let failed = 0;
  for (const source of config.sources) {
    const asSearch = (label: string) => label.replace(/[/ ]/g, '-'); // Gmail search syntax for nested labels
    const q = `${source.gmailQuery} newer_than:${g.lookbackDays}d -label:${asSearch(g.processedLabel)} -label:${asSearch(g.failedLabel)}`;
    for (const id of await listMessageIds(q, g.maxPerRun)) {
      const email = await getMessage(id);
      try {
        const result = await processOrderEmail(email, source);
        await addLabel(id, g.processedLabel);
        if (result.outcome === 'skipped') log('info', `Skipped "${email.subject}": ${result.reason}`, result.jiraKey);
        processed++;
      } catch (e) {
        failed++;
        const msg = (e as Error).message;
        log('error', `Failed on "${email.subject}": ${msg}`);
        await addLabel(id, g.failedLabel).catch(() => undefined);
        await postToItChannel(errorAlert(`${source.name} email "${email.subject}"`,
          `${msg}\nThe email was labelled "${g.failedLabel}". Remove the label to retry.`)).catch(() => undefined);
      }
    }
  }
  return { processed, failed };
}
