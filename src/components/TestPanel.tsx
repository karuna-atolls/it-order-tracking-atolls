import { useState } from 'react';
import { api } from '../api';

/** Paste a supplier email and see what the app reads from it and which ticket it matches. Nothing is written. */
export default function TestPanel({ sources }: { sources: string[] }) {
  const [source, setSource] = useState(sources[0] || '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api('/test/extract', { source: source || sources[0], subject, body }));
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <p className="muted">Paste a supplier email to check what Gemini reads and which ticket and requester it finds. Dry run: nothing is changed in Jira, Slack or Assets.</p>
      <div className="row">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {sources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input placeholder="Email subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <textarea rows={12} placeholder="Email body" value={body} onChange={(e) => setBody(e.target.value)} />
      <button className="primary" onClick={test} disabled={busy || !body}>{busy ? 'Reading…' : 'Run dry run'}</button>
      {result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}
