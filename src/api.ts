export interface OrderRow {
  id: string;
  jiraKey: string;
  url: string;
  summary: string;
  source: string;
  orderNumber: string | null;
  requester: string | null;
  inSlack: boolean;
  delivery: string;
  status: string;
  updatedAt: string;
  waitingForReceipt: boolean;
  queuedForUser: number;
  waitingPreviews: number;
  closingError: string | null;
  items: { name: string; status: string; category: string; serials: string[]; assets: string[] }[];
}

export interface PendingRow { id: string; source: string; subject: string; reason: string; orderNumber: string | null; receivedAt: string }

export interface LogEntry { time: string; level: 'info' | 'warn' | 'error'; message: string; jiraKey?: string }

export interface SetupInfo {
  settings: { autoSend: boolean; changedBy: string | null; changedAt: string | null };
  secrets: Record<string, boolean>;
  storage: string;
  config: {
    jiraBaseUrl: string;
    projectKey: string;
    sources: { name: string; allowedSenders: string[] }[];
    geminiModel: string;
    userDmMode: string;
    todo: string[];
  };
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}
