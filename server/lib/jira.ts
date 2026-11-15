import { config } from '../config';
import { env } from '../env';
import type { JiraIssue } from '../types';
import { HttpError, requestJson } from './http';

export const atlassianAuth = () =>
  'Basic ' + Buffer.from(`${env('JIRA_EMAIL')}:${env('JIRA_API_TOKEN')}`).toString('base64');

function jira<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(`${config.jira.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: atlassianAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
  }, `Jira ${init.method || 'GET'} ${path.split('?')[0]}`);
}

export const ticketUrl = (key: string) => `${config.jira.baseUrl}/browse/${key}`;

/** A field ID counts as configured when it is filled in and is not a placeholder. */
export const isConfigured = (fieldId: string) => !!fieldId && !/X{3,}/i.test(fieldId);

function issueFields(): string[] {
  const f = config.jira.fields;
  return ['summary', 'status', 'reporter', ...[f.deliveryOffice, f.orderStatus, f.orderNumber].filter(isConfigured)];
}

/** Returns null when the ticket does not exist or the API user cannot see it. */
export async function getIssue(key: string): Promise<JiraIssue | null> {
  try {
    return await jira<JiraIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=${issueFields().join(',')}`);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

export const isDone = (issue: JiraIssue) => issue.fields.status?.statusCategory?.key === 'done';

export const updateFields = (key: string, fields: Record<string, unknown>) =>
  jira(`/rest/api/2/issue/${key}`, { method: 'PUT', body: JSON.stringify({ fields }) });

/** Comment in Jira wiki markup. internal=true hides it from the requester (Jira Service Management). */
export const addComment = (key: string, body: string, internal: boolean) =>
  jira(`/rest/api/2/issue/${key}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body, properties: [{ key: 'sd.public.comment', value: { internal } }] }),
  });

/** Close the ticket by moving it to the first configured close status the workflow offers. */
export async function closeTicket(key: string): Promise<'closed' | 'already' | 'missing'> {
  const issue = await getIssue(key);
  if (issue && isDone(issue)) return 'already';
  const { transitions } = await jira<{ transitions: { id: string; to?: { name?: string }; fields?: Record<string, unknown> }[] }>(
    `/rest/api/2/issue/${key}/transitions?expand=transitions.fields`);
  for (const status of config.jira.closeStatuses) {
    const t = transitions.find((x) => (x.to?.name || '').toLowerCase() === status.toLowerCase());
    if (!t) continue;
    const fields = t.fields && 'resolution' in t.fields ? { resolution: { name: config.jira.closeResolution } } : undefined;
    await jira(`/rest/api/2/issue/${key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: t.id }, fields }) });
    return 'closed';
  }
  return 'missing';
}

const accountIds = new Map<string, string | null>();
/** Atlassian account ID for an email address (used to tag someone on a ticket). */
export async function findAccountId(email: string): Promise<string | null> {
  if (accountIds.has(email)) return accountIds.get(email)!;
  let id: string | null = null;
  try {
    const users = await jira<{ accountId: string; accountType?: string }[]>(`/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
    id = users.find((u) => u.accountType !== 'app')?.accountId || null;
  } catch { /* tagging is best effort */ }
  accountIds.set(email, id);
  return id;
}

export const mention = (accountId: string) => `[~accountid:${accountId}]`;

/** Download an image attachment (for reading a serial number from a photo). */
export async function getImageAttachment(id: string): Promise<{ mimeType: string; data: string } | null> {
  const meta = await jira<{ mimeType?: string; size?: number }>(`/rest/api/3/attachment/${id}`);
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(meta.mimeType || '') || (meta.size || 0) > 10 * 1024 * 1024) return null;
  const res = await fetch(`${config.jira.baseUrl}/rest/api/3/attachment/content/${id}`, { headers: { Authorization: atlassianAuth() } });
  if (!res.ok) throw new HttpError(res.status, await res.text(), 'Jira attachment download');
  return { mimeType: meta.mimeType!, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
}

/** Setup helper: find custom field IDs by (part of) their name. */
export async function searchFields(q: string): Promise<{ id: string; name: string }[]> {
  const all = await jira<{ id: string; name: string }[]>('/rest/api/2/field');
  return all.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).map((f) => ({ id: f.id, name: f.name }));
}
