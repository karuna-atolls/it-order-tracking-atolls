import { useCallback, useEffect, useState } from 'react';
import { api, type LogEntry, type OrderRow, type PendingRow, type SetupInfo } from '../api';
import SetupPanel from './SetupPanel';
import TestPanel from './TestPanel';

const STATUS_CLASS: Record<string, string> = {
  Ordered: 'blue', 'Partially shipped': 'purple', Shipped: 'purple', Delayed: 'amber',
  'Partially delivered': 'teal', Delivered: 'green', Cancelled: 'red',
};

type Tab = 'orders' | 'attention' | 'setup' | 'test' | 'log';

export default function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [logEntries, setLog] = useState<LogEntry[]>([]);
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>('orders');

  const refresh = useCallback(async () => {
    setError('');
    api<SetupInfo>('/setup').then(setSetup).catch(() => undefined);
    api<LogEntry[]>('/log').then(setLog).catch(() => undefined);
    api<PendingRow[]>('/pending').then(setPending).catch(() => undefined);
    try {
      setOrders(await api<OrderRow[]>('/orders'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function run(label: string, path: string, body: unknown = {}) {
    setBusy(label);
    setNotice('');
    try {
      setNotice(`${label}: ${JSON.stringify(await api(path, body))}`);
      await refresh();
    } catch (e) {
      setNotice(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  const missing = setup ? Object.entries(setup.secrets).filter(([, ok]) => !ok).map(([n]) => n) : [];
  const attention = orders.filter((o) => o.closingError || !o.inSlack);

  return (
    <div className="page">
      <header>
        <div>
          <h1>IT Order Notifier</h1>
          {setup && (
            <p className="muted">
              {setup.config.projectKey} · {setup.config.sources.map((s) => s.name).join(', ')} · {setup.config.geminiModel} · storage: {setup.storage}
            </p>
          )}
        </div>
        <div className="actions">
          <button onClick={() => run('Email check', '/cron/poll')} disabled={!!busy}>{busy === 'Email check' ? 'Checking…' : 'Check emails now'}</button>
          <button onClick={() => run('Digest', '/cron/digest')} disabled={!!busy}>{busy === 'Digest' ? 'Sending…' : 'Send user updates now'}</button>
          <button onClick={() => run('Reminders', '/cron/reminders')} disabled={!!busy}>{busy === 'Reminders' ? 'Sending…' : 'Run reminders now'}</button>
          <button className="ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {(missing.length > 0 || (setup?.config.todo.length ?? 0) > 0) && (
        <div className="banner warn">
          <strong>Setup incomplete.</strong>
          {missing.length > 0 && <> Missing secrets: {missing.join(', ')}.</>}
          {setup?.config.todo.map((t) => <span key={t}> {t}.</span>)}
        </div>
      )}
      {setup && (
        <div className={`banner mode ${setup.settings.autoSend ? 'live' : 'review'}`}>
          <div>
            {setup.settings.autoSend ? (
              <><strong>Automatic sending is ON.</strong> Requesters and office channels get messages without approval.</>
            ) : (
              <><strong>Review mode.</strong> Nothing goes to requesters or office channels until you press <em>Send</em> on the preview in #it-hardware-orders. Jira order comments are internal.</>
            )}
            {setup.settings.changedAt && <span className="muted small"> · changed {new Date(setup.settings.changedAt).toLocaleString()}</span>}
          </div>
          <button
            className={setup.settings.autoSend ? '' : 'primary'}
            disabled={!!busy}
            onClick={() => {
              const enable = !setup.settings.autoSend;
              if (enable && !window.confirm('Turn on automatic sending? From now on requesters and office channels receive messages without your approval. Previews already waiting in Slack still need a click.')) return;
              run(enable ? 'Automatic sending on' : 'Review mode on', '/settings/auto-send', { enabled: enable });
            }}
          >
            {setup.settings.autoSend ? 'Back to review mode' : 'Turn on automatic sending'}
          </button>
        </div>
      )}
      {notice && <div className="banner">{notice}</div>}

      <nav className="tabs">
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Open orders ({orders.length})</button>
        <button className={tab === 'attention' ? 'active' : ''} onClick={() => setTab('attention')}>Needs attention ({pending.length + attention.length})</button>
        <button className={tab === 'setup' ? 'active' : ''} onClick={() => setTab('setup')}>Setup check</button>
        <button className={tab === 'test' ? 'active' : ''} onClick={() => setTab('test')}>Test an email</button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>Activity</button>
      </nav>

      {tab === 'orders' && (
        <section className="card">
          {error && <p className="error">{error}</p>}
          {!error && orders.length === 0 && <p className="muted">No open orders yet. They appear here once the first supplier email is processed.</p>}
          {orders.map((o) => (
            <div className="order" key={o.id}>
              <div className="order-head">
                <div>
                  <a href={o.url} target="_blank" rel="noreferrer">{o.jiraKey}</a> <strong>{o.summary}</strong>
                  <div className="muted small">
                    {o.source} order {o.orderNumber || '—'} · {o.requester || 'unknown requester'} · {o.delivery}
                    {o.waitingForReceipt && ' · waiting for the user to confirm'}
                    {o.queuedForUser > 0 && ` · ${o.queuedForUser} update(s) queued for the user`}
                    {o.waitingPreviews > 0 && ` · ${o.waitingPreviews} preview(s) waiting for Send in Slack`}
                  </div>
                </div>
                <div className="actions">
                  <span className={`pill ${STATUS_CLASS[o.status] || ''}`}>{o.status}</span>
                  {o.status !== 'Delivered' && (
                    <button className="small-btn" disabled={!!busy} onClick={() => run(`Mark ${o.jiraKey} delivered`, '/actions/mark-delivered', { orderId: o.id })}>Mark delivered</button>
                  )}
                </div>
              </div>
              <ul className="items">
                {o.items.map((i) => (
                  <li key={i.name}>
                    <span className={`pill ${STATUS_CLASS[i.status] || ''}`}>{i.status}</span> {i.name}
                    {i.serials.length > 0 && <span className="muted small"> · SN {i.serials.join(', ')}</span>}
                    {i.assets.length > 0 && <span className="muted small"> · {i.assets.join(', ')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {tab === 'attention' && (
        <section className="card">
          {pending.length + attention.length === 0 && <p className="muted">Nothing needs attention.</p>}
          {pending.map((p) => (
            <div className="order" key={p.id}>
              <strong>{p.source} email without a ticket</strong>
              <div className="small">{p.subject}</div>
              <div className="muted small">{p.reason}{p.orderNumber && ` · order ${p.orderNumber}`} · use "Link ticket" in the Slack master channel</div>
            </div>
          ))}
          {attention.map((o) => (
            <div className="order" key={o.id}>
              <div className="order-head">
                <div>
                  <a href={o.url} target="_blank" rel="noreferrer">{o.jiraKey}</a> <strong>{o.summary}</strong>
                  {!o.inSlack && <div className="error small">Requester not found in Slack — use "Set user" in the master channel</div>}
                  {o.closingError && <div className="error small">Closing failed: {o.closingError}</div>}
                </div>
                {o.closingError && (
                  <button className="small-btn" disabled={!!busy} onClick={() => run(`Retry closing ${o.jiraKey}`, '/actions/retry-closing', { orderId: o.id })}>Retry closing</button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {tab === 'setup' && <SetupPanel />}
      {tab === 'test' && <TestPanel sources={setup?.config.sources.map((s) => s.name) || []} />}

      {tab === 'log' && (
        <section className="card">
          {logEntries.length === 0 && <p className="muted">Nothing logged since the server started.</p>}
          <ul className="log">
            {logEntries.map((l, i) => (
              <li key={i} className={l.level}>
                <span className="small muted">{new Date(l.time).toLocaleString()}</span>
                {l.jiraKey && <strong> {l.jiraKey}</strong>} {l.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
