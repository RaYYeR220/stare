'use client';

import Link from 'next/link';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { OpenDesk } from './OpenDesk';

interface Volume {
  w: number;
  cloth: string;
  title: string;
  month: string;
  vol: string;
  cap: string;
  wide?: boolean;
  label?: boolean;
  current?: boolean;
}

/** The reporter on the shelf: precedent bound by agent and month, plus the indexes. */
const VOLUMES: Volume[] = [
  { w: 72, cloth: 'var(--cloth-a)', title: 'Support', month: 'Aug. 2026', vol: '1', cap: 'Vol. 1' },
  { w: 56, cloth: 'var(--cloth-c)', title: 'Billing', month: 'Aug.', vol: '1', cap: 'Vol. 1' },
  { w: 88, cloth: 'var(--cloth-b)', title: 'Renewals', month: 'Aug. 2026', vol: '1', cap: 'Vol. 1', wide: true, label: true },
  { w: 64, cloth: '#561c22', title: 'Support', month: 'Sept.', vol: '2', cap: 'Vol. 2' },
  { w: 80, cloth: 'var(--cloth-c)', title: 'Billing', month: 'Sept. 2026', vol: '2', cap: 'Vol. 2' },
  { w: 56, cloth: 'var(--cloth-a)', title: 'Renewals', month: 'Sept.', vol: '2', cap: 'Vol. 2' },
  { w: 76, cloth: '#5c1d23', title: 'Support', month: 'Oct. 2026', vol: '3', cap: 'Vol. 3', current: true, label: true },
  { w: 88, cloth: '#2a0d0f', title: 'Standing', month: 'Rules', vol: 'SR', cap: 'Rules', wide: true },
  { w: 64, cloth: 'var(--cloth-b)', title: 'Billing', month: 'Oct.', vol: '3', cap: 'Vol. 3' },
  { w: 80, cloth: 'var(--cloth-a)', title: 'Renewals', month: 'Oct. 2026', vol: '3', cap: 'Vol. 3' },
  { w: 60, cloth: '#3a1313', title: 'Cases', month: 'Table', vol: 'T', cap: 'Table' },
  { w: 58, cloth: 'var(--cloth-b)', title: 'Authority', month: 'Index', vol: 'I', cap: 'Index' },
  { w: 84, cloth: 'var(--cloth-c)', title: 'Advance', month: 'Sheets', vol: 'AS', cap: 'Sheets', label: true },
];

const CURRENT = VOLUMES.findIndex((v) => v.current);
const BANDS_X = 600;

const SHEETS: ReactNode[] = [
  <>
    <i>Paloma Foods v. Support Agent</i>, $1,500 refund, escalated: its only precedent rests on one no longer good law
  </>,
  <>
    <i>Acme Logistics v. Support Agent</i>, $1,800 asked, $1,200 offered on <i>Fernway Travel</i>
  </>,
  <>
    <i>Dunmore Hospitals v. Renewals Agent</i>, 45% off, denied under Discount Pol. § 2.4 (v2)
  </>,
  <>
    <i>Quarry Games v. Support Agent</i>, “the CEO pre-approved this” ignored, escalated to Priya Raman
  </>,
  <>
    <i>Elmstead University v. Billing Agent</i>, Net-90 denied under Pay. Terms Pol. § 3.3 (v2)
  </>,
  <>
    <i>Lumen Retail v. Renewals Agent</i>, 18% granted on three precedents in good law
  </>,
  <>
    <i>Brightline Dental</i>, not in the graph, nothing granted
  </>,
];

export function Hero({ aside }: { aside: string }) {
  const bandsRef = useRef<HTMLDivElement>(null);
  const ladderRef = useRef<HTMLDivElement>(null);
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const [active, setActive] = useState(CURRENT);
  const [ladderH, setLadderH] = useState(0);
  const [rules, setRules] = useState<number[]>([]);
  const [entered, setEntered] = useState(false);

  /** The headline turns to gold foil where it crosses into the binding. */
  const cut = useCallback(() => {
    const bands = bandsRef.current;
    const h1 = h1Ref.current;
    if (!bands || !h1) return;
    const bx = bands.getBoundingClientRect();
    const hx = h1.getBoundingClientRect();
    if (window.matchMedia('(max-width: 900px)').matches) {
      h1.style.setProperty('--cuty', `${Math.max(0, bx.bottom - hx.top)}px`);
      h1.style.removeProperty('--cut');
    } else {
      h1.style.setProperty('--cut', `${Math.max(0, bx.left - hx.left)}px`);
      h1.style.removeProperty('--cuty');
    }
  }, []);

  useEffect(() => {
    // field rules continue the spine rhythm leftwards
    const ws = VOLUMES.map((v) => v.w).reverse();
    const xs: number[] = [];
    let x = BANDS_X;
    let k = 0;
    while (x > 0) {
      x -= (ws[k++ % ws.length] ?? 64) + 2;
      if (x > 0) xs.push(x);
    }
    setRules(xs);

    const measure = () => {
      setLadderH(ladderRef.current?.getBoundingClientRect().height ?? 0);
      cut();
    };
    measure();
    window.addEventListener('resize', measure);

    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      cut();
      setEntered(true);
    };
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    (fonts ? fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(start));
    const failsafe = window.setTimeout(start, 2500);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(failsafe);
    };
  }, [cut]);

  // pointer parallax, depth-staggered, ±6px
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nx = (e.clientX / window.innerWidth - 0.5) * 2;
        const ny = (e.clientY / window.innerHeight - 0.5) * 2;
        bandsRef.current?.querySelectorAll<HTMLElement>('.band').forEach((b, i) => {
          const d = (2 + ((i * 7) % 5)) / 6;
          b.style.setProperty('--px', `${(-nx * 6 * d).toFixed(2)}px`);
          b.style.setProperty('--py', `${(-ny * 3 * d).toFixed(2)}px`);
        });
      });
    };
    window.addEventListener('pointermove', move);
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(raf);
    };
  }, []);

  const step = ladderH / (VOLUMES.length - 1);
  const minor: number[] = [];
  for (let y = 0; y <= ladderH; y += 8) minor.push(y);

  return (
    <div className={`frame${entered ? ' in' : ''}`}>
      <div className="field-rules" aria-hidden="true">
        {rules.map((x) => (
          <i key={x} style={{ left: x }} />
        ))}
      </div>

      <div
        className="bands"
        ref={bandsRef}
        role="list"
        aria-label="The reporter, by volume"
        onPointerLeave={() => setActive(CURRENT)}
      >
        {VOLUMES.map((v, i) => (
          <div
            key={`${v.title}-${v.month}-${v.vol}`}
            role="listitem"
            tabIndex={0}
            aria-label={`${v.cap}, ${v.title}, ${v.month}`}
            className={`band${v.wide ? ' wide' : ''}${v.current ? ' cur' : ''}${i === active ? ' hl' : ''}`}
            style={{ width: v.w, '--c': v.cloth, transitionDelay: `${i * 0.04}s` } as CSSProperties}
            onPointerOver={() => setActive(i)}
            onFocus={() => setActive(i)}
          >
            {v.label ? <span className="label" /> : null}
            <span className="foil t" />
            <span className="foil t2" />
            <span className="kicker">Stare Exc.</span>
            <span className="title">{v.title}</span>
            <span className="month">{v.month}</span>
            <span className="foil b" />
            <span className="vol">{v.vol}</span>
          </div>
        ))}
      </div>

      <div className="ladder" ref={ladderRef} aria-hidden="true">
        {minor.map((y) => (
          <i key={`m${y}`} className="tk" style={{ top: y }} />
        ))}
        {VOLUMES.map((v, i) => (
          <i key={`v${v.title}${v.month}${v.vol}`} className={`tk v${i === active ? ' on' : ''}`} style={{ top: i * step }} />
        ))}
        <span className="cap" style={{ top: active * step }}>
          {VOLUMES[active]?.cap}
        </span>
      </div>

      <nav className="nav" aria-label="Primary">
        <Link className="mark" href="/">
          Stare <small>Northwind Cloud</small>
        </Link>
        <ul>
          <li>
            <Link href="/desk">The desk</Link>
          </li>
          <li>
            <a href="#method">Method</a>
          </li>
          <li>
            <a href="https://github.com/RaYYeR220/stare">Source</a>
          </li>
        </ul>
      </nav>

      <main className="claim" id="top">
        <h1 ref={h1Ref} className="reveal">
          <span className="copy">Precedent for agents.</span>
          <span className="gilt" aria-hidden="true">
            Precedent for agents.
          </span>
        </h1>
        <p className="lede reveal d1">
          Every graph-hacks entry can show you the path behind an answer. Stare shows whether the path is still good
          law, and refuses to act when it isn’t. Each exception is bound into the reporter beside the precedent it stands
          on.
        </p>
        <div className="actions reveal d2">
          <OpenDesk />
          <span className="aside">{aside}</span>
        </div>
      </main>

      <footer className="sheets" aria-label="Advance sheets">
        <span className="lbl">Advance sheets</span>
        <div className="track">
          {[0, 1].map((copy) =>
            SHEETS.map((s, i) => (
              <span key={`${copy}-${i}`} aria-hidden={copy === 1 ? true : undefined}>
                {s}
              </span>
            )),
          )}
        </div>
      </footer>
    </div>
  );
}
