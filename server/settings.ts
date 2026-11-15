/** Settings that can be changed from the dashboard while the app runs (stored with the order data). */
import { config } from './config';
import { store } from './store';

export interface Settings {
  autoSend: boolean;
  changedBy: string | null;
  changedAt: string | null;
}

export async function getSettings(): Promise<Settings> {
  const saved = await store.get<Settings>('meta', 'settings');
  return saved || { autoSend: config.notifications.autoSendDefault, changedBy: null, changedAt: null };
}

export async function setAutoSend(autoSend: boolean, by: string): Promise<Settings> {
  const s: Settings = { autoSend, changedBy: by, changedAt: new Date().toISOString() };
  await store.set('meta', 'settings', s, false);
  return s;
}

/** true = messages go straight to requesters and office channels; false = review mode. */
export const autoSend = async () => (await getSettings()).autoSend;
