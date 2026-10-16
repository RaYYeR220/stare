'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type DeskApi, deskApi, publicApi, sessionStore } from './api';
import type { Overview, Person, Session } from './types';
import { type Resource, useResource } from './useResource';

type Status = 'loading' | 'opening' | 'ready' | 'closed' | 'failed';

interface DeskContext {
  status: Status;
  session: Session | null;
  /** Why the desk is closed or failed to open, in the desk's own words. */
  message: string | null;
  api: DeskApi;
  open: () => Promise<void>;
  overview: Resource<Overview>;
  people: Person[];
  peopleResource: Resource<Person[]>;
  personName: (id: string | null | undefined) => string;
  /** Call after anything that changes the graph, so the header and lists catch up. */
  touch: () => void;
  version: number;
}

const Ctx = createContext<DeskContext | null>(null);

/** Wrap every call so an expired token closes the desk instead of surfacing as a panel error. */
function guarded(api: DeskApi, onExpired: (e: ApiError) => void): DeskApi {
  const out: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(api)) {
    out[k] = (...args: unknown[]) =>
      (fn as (...a: unknown[]) => Promise<unknown>)(...args).catch((e: unknown) => {
        if (e instanceof ApiError && e.expired) onExpired(e);
        throw e;
      });
  }
  return out as DeskApi;
}

export function DeskProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const opening = useRef<Promise<void> | null>(null);

  const open = useCallback(async () => {
    if (opening.current) return opening.current;
    setStatus('opening');
    setMessage(null);
    opening.current = publicApi
      .openSession()
      .then((s) => {
        sessionStore.write(s);
        setSession(s);
        setStatus('ready');
      })
      .catch((e: Error) => {
        setStatus('failed');
        setMessage(e.message);
      })
      .finally(() => {
        opening.current = null;
      });
    return opening.current;
  }, []);

  useEffect(() => {
    const s = sessionStore.read();
    if (s && s.expiresAt > Date.now()) {
      setSession(s);
      setStatus('ready');
    } else if (s) {
      setStatus('closed');
      setMessage('This desk reached the end of its two hours and was cleared.');
    } else {
      void open();
    }
  }, [open]);

  const onExpired = useCallback((e: ApiError) => {
    sessionStore.clear();
    setStatus('closed');
    setMessage(e.message);
  }, []);

  const api = useMemo(() => guarded(deskApi(session?.token ?? ''), onExpired), [session, onExpired]);
  const ready = status === 'ready' && session !== null;

  const overview = useResource(ready ? (s) => api.overview(s) : null, `${session?.token}:${version}`);
  const peopleRes = useResource(ready ? (s) => api.people(s) : null, `${session?.token}:${version}`);
  const people = peopleRes.data ?? [];
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const personName = useCallback(
    (id: string | null | undefined) => (id ? (names.get(id) ?? id) : 'nobody'),
    [names],
  );
  const touch = useCallback(() => setVersion((v) => v + 1), []);

  const value: DeskContext = { status, session, message, api, open, overview, people, peopleResource: peopleRes, personName, touch, version };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDesk(): DeskContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDesk outside DeskProvider');
  return c;
}
