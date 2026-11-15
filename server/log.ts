/** Small in-memory activity log shown on the dashboard (resets when the server restarts). */
export interface LogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  jiraKey?: string;
}

const entries: LogEntry[] = [];
const MAX = 300;

export function log(level: LogEntry['level'], message: string, jiraKey?: string | null) {
  entries.unshift({ time: new Date().toISOString(), level, message, jiraKey: jiraKey || undefined });
  if (entries.length > MAX) entries.length = MAX;
  const line = `[${level}]${jiraKey ? ` ${jiraKey}` : ''} ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
}

export const recentLog = () => entries;
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
