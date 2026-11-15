import { useState } from 'react';
import { api } from '../api';

/** Read-only checks against Slack, Jira and Assets, to confirm the configuration before going live. */
export default function SetupPanel() {
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const [fieldQuery, setFieldQuery] = useState('office');

  async function check(label: string, path: string) {
    setBusy(label);
    setResult(null);
    try {
      setResult(await api(path));
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="card">
      <p className="muted">These checks only read. Nothing is changed in Slack, Jira or Assets.</p>
      <div className="row">
        <button onClick={() => check('slack', '/setup/slack')} disabled={!!busy}>
          {busy === 'slack' ? 'Checking…' : 'Slack channels the bot can post to'}
        </button>
        <button onClick={() => check('assets', '/setup/assets')} disabled={!!busy}>
          {busy === 'assets' ? 'Checking…' : 'How Assets objects will be filled'}
        </button>
      </div>
      <div className="row">
        <input value={fieldQuery} onChange={(e) => setFieldQuery(e.target.value)} placeholder="Part of a Jira field name" />
        <button onClick={() => check('fields', `/setup/jira-fields?q=${encodeURIComponent(fieldQuery)}`)} disabled={!!busy || !fieldQuery}>
          {busy === 'fields' ? 'Searching…' : 'Find Jira field ID'}
        </button>
      </div>
      {result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}
