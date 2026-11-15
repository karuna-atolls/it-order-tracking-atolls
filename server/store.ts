/**
 * Persistence for order state. Uses Firestore (REST API, via the service account) when
 * GOOGLE_SERVICE_ACCOUNT_JSON is set; otherwise an in-memory store that is lost on restart
 * (fine for the AI Studio preview, not for production).
 *
 * Each record is stored as one JSON string plus an "open" flag, so no indexes are needed.
 */
import { config } from './config';
import { hasEnv } from './env';
import { googleToken, serviceAccount } from './lib/google';
import { HttpError, requestJson } from './lib/http';
import { log } from './log';

export type Collection = 'orders' | 'pending' | 'meta';

interface Backend {
  get(col: string, id: string): Promise<string | null>;
  set(col: string, id: string, json: string, open: boolean): Promise<void>;
  remove(col: string, id: string): Promise<void>;
  listOpen(col: string): Promise<string[]>;
}

const memory = new Map<string, { json: string; open: boolean }>();
const memoryBackend: Backend = {
  async get(col, id) { return memory.get(`${col}/${id}`)?.json ?? null; },
  async set(col, id, json, open) { memory.set(`${col}/${id}`, { json, open }); },
  async remove(col, id) { memory.delete(`${col}/${id}`); },
  async listOpen(col) {
    return [...memory.entries()].filter(([k, v]) => k.startsWith(`${col}/`) && v.open).map(([, v]) => v.json);
  },
};

const firestoreBase = () =>
  `https://firestore.googleapis.com/v1/projects/${serviceAccount().project_id}/databases/${process.env.FIRESTORE_DATABASE || '(default)'}/documents`;

async function firestore<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await googleToken('https://www.googleapis.com/auth/datastore');
  return requestJson<T>(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, 'Firestore');
}

const firestoreBackend: Backend = {
  async get(col, id) {
    try {
      const doc = await firestore<{ fields?: { json?: { stringValue?: string } } }>(`${firestoreBase()}/${col}/${id}`);
      return doc.fields?.json?.stringValue ?? null;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  },
  async set(col, id, json, open) {
    await firestore(`${firestoreBase()}/${col}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: { json: { stringValue: json }, open: { booleanValue: open }, updatedAt: { timestampValue: new Date().toISOString() } },
      }),
    });
  },
  async remove(col, id) {
    await firestore(`${firestoreBase()}/${col}/${id}`, { method: 'DELETE' });
  },
  async listOpen(col) {
    const rows = await firestore<{ document?: { fields?: { json?: { stringValue?: string } } } }[]>(`${firestoreBase()}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: col }],
          where: { fieldFilter: { field: { fieldPath: 'open' }, op: 'EQUAL', value: { booleanValue: true } } },
          limit: 500,
        },
      }),
    });
    return rows.map((r) => r.document?.fields?.json?.stringValue).filter((s): s is string => !!s);
  },
};

export const usingFirestore = () => hasEnv('GOOGLE_SERVICE_ACCOUNT_JSON') && process.env.STORE !== 'memory';

let warned = false;
function backend(): Backend {
  if (usingFirestore()) return firestoreBackend;
  if (!warned) {
    warned = true;
    log('warn', 'No GOOGLE_SERVICE_ACCOUNT_JSON: order state is kept in memory only and is lost on restart');
  }
  return memoryBackend;
}

const col = (c: Collection) => `${config.store.collectionPrefix}${c}`;
const docId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 200);

export const store = {
  async get<T>(c: Collection, id: string): Promise<T | null> {
    const json = await backend().get(col(c), docId(id));
    return json ? (JSON.parse(json) as T) : null;
  },
  async set<T>(c: Collection, id: string, value: T, open = true): Promise<void> {
    await backend().set(col(c), docId(id), JSON.stringify(value), open);
  },
  async remove(c: Collection, id: string): Promise<void> {
    await backend().remove(col(c), docId(id));
  },
  async listOpen<T>(c: Collection): Promise<T[]> {
    return (await backend().listOpen(col(c))).map((j) => JSON.parse(j) as T);
  },
};

/** Run one task at a time per key (prevents two updates to the same order from overwriting each other). */
const chains = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(key, next);
  next.catch(() => undefined).finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}
