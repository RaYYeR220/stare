'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Failure, Meter } from '@/components/bits';
import { Glyph } from '@/components/Glyph';
import { useDesk } from '@/lib/desk';
import { count, money, short, time } from '@/lib/format';
import type { Budget } from '@/lib/types';

interface Section {
  href: string;
  label: string;
  count?: number | null;
  sub?: boolean;
}

const BUDGET_NAME: Record<string, string> = {
  refunds: 'Refund budget, this quarter',
  discounts: 'Discounts the agents may still grant',
  payment_terms: 'Extended terms the agents may still grant',
};

function budgetFormat(b: Budget) {
  return b.unit === 'usd' ? money : (v: number) => count(v);
}

/** Header strip: standing of the reporter, open escalations, autonomy budgets, ledger head. */
function Strip() {
  const { overview } = useDesk();
  const o = overview.data;
  if (!o) {
    return (
      <div className="strip">
        <div className="strip-wait">
          {overview.error ? (
            <Failure error={overview.error} retry={overview.reload}>
              The desk’s headline numbers did not load.
            </Failure>
          ) : (
            <span className="muted">Reading the reporter…</span>
          )}
        </div>
      </div>
    );
  }
  const cells: { glyph: 'green' | 'yellow' | 'red' | 'pending'; n: number; label: string; href?: string }[] = [
    { glyph: 'green', n: o.green, label: 'Good law' },
    { glyph: 'yellow', n: o.yellow, label: 'Overruling Risk' },
    { glyph: 'red', n: o.red, label: 'Not good law' },
    { glyph: 'pending', n: o.open, label: 'Open escalations', href: '/desk/approvals' },
  ];
  return (
    <section className="strip" aria-label="The desk at a glance" style={{ opacity: overview.loading ? 0.7 : 1 }}>
      {cells.map((c) => (
        <div key={c.label} className="strip-cell">
          <span className="strip-figure">
            <Glyph signal={c.glyph} title={false} />
            {c.href ? <Link href={c.href}>{count(c.n)}</Link> : count(c.n)}
          </span>
          <span className="strip-label">{c.label}</span>
        </div>
      ))}
      <div className="strip-ledger">
        <span>
          Ledger #{o.ledgerSeq} <code title={o.ledgerHead}>{short(o.ledgerHead, 12)}</code>
        </span>
        <span>
          {count(o.decisions)} decisions, model <code>{o.model}</code>
          {o.offline ? ' (offline)' : ''}
        </span>
      </div>
      <div className="strip-budgets">
        {o.budgets.map((b) => (
          <Meter key={b.id} label={BUDGET_NAME[b.policyId] ?? b.id} remaining={b.remaining} cap={b.cap} format={budgetFormat(b)} />
        ))}
      </div>
    </section>
  );
}

function Gate() {
  const { status, message, open } = useDesk();
  if (status === 'loading' || status === 'opening') {
    return (
      <div className="gate" aria-live="polite">
        <h1>Opening your desk.</h1>
        <p>
          A private copy of Northwind Cloud is being made for you: its people, policies, precedent and ledger. It is yours
          for two hours, and nothing you do here touches anyone else’s.
        </p>
      </div>
    );
  }
  return (
    <div className="gate" role="alert">
      <h1>{status === 'closed' ? 'This desk is closed.' : 'The desk did not open.'}</h1>
      <p>
        {status === 'closed'
          ? 'A desk is a private copy of the company that lasts two hours; this one has been cleared.'
          : 'The desk server did not open a desk for you.'}{' '}
        A new desk starts again from a fresh copy of Northwind Cloud.
      </p>
      {message ? <p className="muted">The desk server answered: “{message}”</p> : null}
      <button type="button" className="btn" onClick={() => void open()}>
        Open a new desk
      </button>
    </div>
  );
}

export function DeskShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { status, session, overview, open } = useDesk();
  const navRef = useRef<HTMLElement>(null);
  const [marker, setMarker] = useState<number | null>(null);

  const decisionId = path.startsWith('/desk/decision/') ? decodeURIComponent(path.split('/')[3] ?? '') : null;
  const sections: Section[] = [
    { href: '/desk', label: 'Advance sheets' },
    ...(decisionId ? [{ href: path, label: `Opinion ${decisionId}`, sub: true }] : []),
    { href: '/desk/approvals', label: 'Approvals', count: overview.data?.open ?? null },
    { href: '/desk/rules', label: 'Standing rules' },
    { href: '/desk/policy', label: 'Policy' },
    { href: '/desk/people', label: 'People' },
    { href: '/desk/erasure', label: 'Erasure' },
    { href: '/desk/proof', label: 'Proof' },
    { href: '/desk/memory', label: 'Memory' },
    { href: '/desk/connect', label: 'Connect' },
  ];

  // the gold tick slides to the page you are on
  useLayoutEffect(() => {
    const nav = navRef.current;
    const a = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!nav || !a) return setMarker(null);
    setMarker(a.offsetTop + a.offsetHeight / 2);
    if (window.matchMedia('(max-width: 900px)').matches) a.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [path, decisionId]);

  return (
    <div className="desk">
      <div className="desk-spine" aria-hidden="false">
        <Link className="spine-mark" href="/" prefetch={false}>
          Stare <small>Northwind Cloud</small>
        </Link>
        <span className="spine-foil t" aria-hidden="true" />
        <span className="spine-kicker" aria-hidden="true">
          Stare Exc.
        </span>
        <span className="spine-title" aria-hidden="true">
          {session ? `Desk ${session.sandbox}` : 'Northwind Cloud'}
        </span>
        <span className="spine-month" aria-hidden="true">
          Oct. 2026
        </span>
        <span className="spine-foil b" aria-hidden="true" />
        <span className="spine-vol" aria-hidden="true">
          3
        </span>
      </div>

      <div className="desk-index">
        <Link className="desk-mark" href="/" prefetch={false}>
          Stare <small>Northwind Cloud</small>
        </Link>
        <nav className="ladder-nav" ref={navRef} aria-label="Desk sections">
          <ul>
            {sections.map((s) => (
              <li key={s.href}>
                <Link href={s.href} aria-current={path === s.href ? 'page' : undefined} className={s.sub ? 'ladder-sub' : undefined}>
                  <span>{s.label}</span>
                  {s.count ? <span className="ladder-count">{s.count}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
          {marker !== null ? <span className="ladder-marker" style={{ top: marker }} aria-hidden="true" /> : null}
        </nav>
        <div className="desk-meta">
          {session ? (
            <>
              <span>
                Desk <code>{session.sandbox}</code>, open until {time(session.expiresAt)}
              </span>
              <button type="button" className="linkish" onClick={() => void open()}>
                Open a fresh desk
              </button>
            </>
          ) : (
            <span>No desk open in this browser.</span>
          )}
        </div>
      </div>

      <main className="desk-main" id="main">
        <div className="desk-page">
          {status === 'ready' ? (
            <>
              <Strip />
              {children}
            </>
          ) : (
            <Gate />
          )}
        </div>
      </main>
    </div>
  );
}
