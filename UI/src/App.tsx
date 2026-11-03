import { useEffect, useState } from 'react';

type Health = { ok: boolean; schemaVersion: string | null };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="min-h-screen bg-stone-50 p-10 text-stone-800">
      <h1 className="text-3xl font-semibold">Spa Front Desk</h1>
      <p className="mt-2 text-stone-500">Phase 0 — system check</p>
      <section className="mt-8 rounded-lg border border-stone-200 bg-white p-6">
        {error && <p className="text-red-700">API unreachable: {error}</p>}
        {!error && !health && <p>Checking…</p>}
        {health && (
          <p data-testid="health">
            API ok · database schema <strong>{health.schemaVersion ?? 'not migrated'}</strong>
          </p>
        )}
      </section>
    </main>
  );
}
