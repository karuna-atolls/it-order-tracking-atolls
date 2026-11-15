import { config } from '../config';
import { aql, aqlValue, updateObject } from '../lib/assets';
import { log } from '../log';

/** Jira "issue updated" webhook: when a ticket is closed, its waiting assets become "In use". */
export async function handleJiraWebhook(body: any): Promise<{ updated: number } | { ignored: string }> {
  const change = (body?.changelog?.items || []).find((c: any) => c.field === 'status');
  const key: string | undefined = body?.issue?.key;
  const done = config.jira.doneStatuses.map((s) => s.toLowerCase());
  if (!key || !change) return { ignored: 'not a status change' };
  if (!done.includes(String(change.toString || '').toLowerCase())) return { ignored: `status ${change.toString} is not a done status` };

  const a = config.assets;
  const objects = await aql(
    `${aqlValue(a.attributeNames.jiraTicket)} = ${aqlValue(key)} AND ${aqlValue(a.attributeNames.status)} = ${aqlValue(a.statuses.awaiting.name)}`,
  );
  for (const obj of objects) {
    await updateObject(obj.id, obj.objectType?.id || '', { [a.attributes.status]: a.statuses.inUse.id });
  }
  if (objects.length) log('info', `Ticket closed: ${objects.length} asset(s) set to ${a.statuses.inUse.name}`, key);
  return { updated: objects.length };
}
