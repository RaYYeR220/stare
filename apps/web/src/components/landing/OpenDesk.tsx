'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { publicApi, sessionStore } from '@/lib/api';

/**
 * "Open the desk": reuse this browser's desk while it is still open, otherwise open a private copy of
 * Northwind Cloud for two hours, then go to the reading room.
 */
export function OpenDesk({ label = 'Open the desk' }: { label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setError(null);
    const existing = sessionStore.read();
    if (existing && existing.expiresAt > Date.now() + 60_000) {
      router.push('/desk');
      return;
    }
    setPending(true);
    try {
      sessionStore.write(await publicApi.openSession());
      router.push('/desk');
    } catch (e) {
      setError((e as Error).message);
      setPending(false);
    }
  };

  return (
    <span className="open-desk">
      <button type="button" className="cta" onClick={go} disabled={pending} aria-describedby={error ? 'open-desk-error' : undefined}>
        {pending ? 'Opening your desk' : label}
      </button>
      {error ? (
        <span id="open-desk-error" className="open-desk-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
