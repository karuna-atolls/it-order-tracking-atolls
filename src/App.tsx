import { useEffect, useState } from 'react';
import { api } from './api';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    api<{ signedIn: boolean }>('/me').then((r) => setSignedIn(r.signedIn)).catch(() => setSignedIn(false));
  }, []);

  if (signedIn === null) return <div className="center muted">Loading…</div>;
  if (!signedIn) return <Login onSignedIn={() => setSignedIn(true)} />;
  return <Dashboard onSignOut={() => api('/logout', {}).finally(() => setSignedIn(false))} />;
}
