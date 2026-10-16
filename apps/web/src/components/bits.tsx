'use client';

import type { ReactNode } from 'react';
import { OUTCOME_STAMP } from '@/lib/format';
import type { Outcome } from '@/lib/types';

const STAMP_TONE: Record<Outcome | 'refused' | 'erased', string> = {
  approved: 'good',
  counter: 'risk',
  escalated: 'pending',
  denied: 'bad',
  not_in_graph: 'neutral',
  needs_info: 'neutral',
  refused: 'bad',
  erased: 'good',
};

/** The outcome stamp on a slip opinion. `stampKey` replays the press when a new verdict lands. */
export function Stamp({
  outcome,
  label,
  stampKey,
  small,
}: {
  outcome: Outcome | 'refused' | 'erased';
  label?: string;
  stampKey?: string | number;
  small?: boolean;
}) {
  const text = label ?? (outcome === 'refused' ? 'Refused' : outcome === 'erased' ? 'Erased' : OUTCOME_STAMP[outcome]);
  return (
    <span key={stampKey} className={`stamp stamp-${STAMP_TONE[outcome]}${small ? ' stamp-small' : ''}`}>
      {text}
    </span>
  );
}

/**
 * A budget meter. The track is a lighter step of the fill; the fill turns to the warning and then
 * the danger tone as the remainder runs out.
 */
export function Meter({
  label,
  remaining,
  cap,
  format,
  of,
}: {
  label: string;
  remaining: number;
  cap: number;
  format: (v: number) => string;
  /** Replaces "of N left" when the meter is a share rather than a budget. */
  of?: string;
}) {
  const share = cap > 0 ? Math.max(0, Math.min(1, remaining / cap)) : 0;
  const tone = share <= 0.05 ? 'bad' : share <= 0.25 ? 'risk' : 'ok';
  return (
    <div className={`meter meter-${tone}`}>
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          {format(remaining)} <span className="meter-of">{of ?? `of ${format(cap)} left`}</span>
        </span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={remaining}
        aria-valuetext={`${format(remaining)} ${of ?? `of ${format(cap)} left`}`}
      >
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="state state-loading" aria-live="polite">
      <span className="state-rule" aria-hidden="true" />
      {children}
    </p>
  );
}

export function Failure({ error, retry, children }: { error: Error; retry?: () => void; children?: ReactNode }) {
  return (
    <div className="state state-error" role="alert">
      <p>
        {children ?? 'That did not load.'} <span className="state-detail">{error.message}</span>
      </p>
      {retry ? (
        <button type="button" className="btn btn-quiet" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="state state-empty">{children}</p>;
}

/** A section heading in the reading room: the title plus one plain line about what the page does. */
export function PageHead({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-lede">{children}</p>
      </div>
      {aside ? <div className="page-aside">{aside}</div> : null}
    </header>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}
