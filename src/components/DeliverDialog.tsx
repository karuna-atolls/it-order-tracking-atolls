import { useState } from 'react';
import { api, type Order } from '../api';

interface Line { manufacturer: string; model: string; serial: string }
const empty = (): Line => ({ manufacturer: '', model: '', serial: '' });

/** Manual delivery: for orders where the supplier sends no delivery email. */
export default function DeliverDialog({ order, onClose, onDone }: {
  order: Order; onClose: () => void; onDone: (message: string) => void;
}) {
  const [lines, setLines] = useState<Line[]>([empty()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (i: number, k: keyof Line, v: string) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ assetsCreated?: number; notified?: string }>('/actions/mark-delivered', {
        jiraKey: order.key,
        items: lines.filter((l) => l.model.trim()),
      });
      onDone(`${order.key} marked delivered — requester notified by ${r.notified}, ${r.assetsCreated ?? 0} asset record(s) created.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Mark {order.key} as delivered</h2>
        <p className="muted">{order.summary} — the requester gets the "ready to collect" DM, and an asset record is created for each device below.</p>
        {lines.map((l, i) => (
          <div className="row" key={i}>
            <input placeholder="Manufacturer (Apple)" value={l.manufacturer} onChange={(e) => set(i, 'manufacturer', e.target.value)} />
            <input placeholder="Model (MacBook Pro 14 M4)" value={l.model} onChange={(e) => set(i, 'model', e.target.value)} />
            <input placeholder="Serial number" value={l.serial} onChange={(e) => set(i, 'serial', e.target.value)} />
          </div>
        ))}
        <button className="ghost" onClick={() => setLines((ls) => [...ls, empty()])}>+ Add device</button>
        {error && <p className="error">{error}</p>}
        <div className="actions end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Mark delivered'}</button>
        </div>
      </div>
    </div>
  );
}
