import { type ReactNode, useId } from 'react';
import { FLAG_NAME } from '@/lib/format';
import type { Flag } from '@/lib/types';

export type SignalKind = Flag | 'pending' | 'questioned';

const LABEL: Record<SignalKind, string> = { ...FLAG_NAME, pending: 'Pending escalation', questioned: 'Questioned' };

/**
 * The Stare signal set: shape carries the status, colour is the second channel.
 * Diamond "+" good law, triangle "!" Overruling Risk, octagon not good law, striped flag pending.
 */
export function Glyph({ signal, size = 16, title }: { signal: SignalKind; size?: number; title?: string | false }) {
  const id = useId();
  const label = title === false ? undefined : (title ?? LABEL[signal]);
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg className={`glyph glyph-${signal}`} width={size} height={size} viewBox="0 0 16 16" {...a11y}>
      {label ? <title>{label}</title> : null}
      {signal === 'green' && (
        <>
          <path d="M8 1.2 14.8 8 8 14.8 1.2 8Z" fill="var(--sig-green)" />
          <path d="M8 5v6M5 8h6" stroke="var(--sig-mark)" strokeWidth="1.5" strokeLinecap="square" />
        </>
      )}
      {signal === 'yellow' && (
        <>
          <path d="M8 1.4 15 14.2H1Z" fill="var(--sig-yellow)" strokeLinejoin="round" />
          <path d="M8 6v4.2" stroke="var(--sig-ink)" strokeWidth="1.5" />
          <rect x="7.25" y="11.4" width="1.5" height="1.5" fill="var(--sig-ink)" />
        </>
      )}
      {signal === 'red' && (
        <>
          <path d="M5.3 1.2h5.4l4.1 4.1v5.4l-4.1 4.1H5.3l-4.1-4.1V5.3Z" fill="var(--sig-red)" />
          <path d="M4.8 8h6.4" stroke="var(--sig-mark)" strokeWidth="1.5" />
        </>
      )}
      {signal === 'pending' && (
        <>
          <defs>
            <pattern id={`${id}s`} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="3" height="3" fill="var(--sig-blue)" />
              <rect width="1.2" height="3" fill="var(--sig-mark)" />
            </pattern>
          </defs>
          <path d="M3 1v14" stroke="var(--sig-blue)" strokeWidth="1.5" />
          <path d="M3.75 2.2H14l-2.2 3.4L14 9H3.75Z" fill={`url(#${id}s)`} stroke="var(--sig-blue)" strokeWidth="1" />
        </>
      )}
      {signal === 'questioned' && (
        <>
          <circle cx="8" cy="8" r="6.8" fill="var(--sig-orange)" />
          <circle cx="8" cy="7.6" r="2.8" fill="none" stroke="var(--sig-ink)" strokeWidth="1.5" />
          <path d="M9.3 9.4 11 11.4" stroke="var(--sig-ink)" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

/** Glyph plus its name, so status is never carried by shape or colour alone. */
export function Signal({ signal, children }: { signal: SignalKind; children?: ReactNode }) {
  return (
    <span className={`signal signal-${signal}`}>
      <Glyph signal={signal} title={false} />
      <span>{children ?? LABEL[signal]}</span>
    </span>
  );
}
