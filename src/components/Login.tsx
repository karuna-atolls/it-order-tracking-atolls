import { useState, type FormEvent } from 'react';
import { api } from '../api';

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { password });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>IT Order Notifier</h1>
        <p className="muted">Sign in with the admin password.</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
