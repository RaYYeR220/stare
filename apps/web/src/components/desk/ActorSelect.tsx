'use client';

import { useDesk } from '@/lib/desk';
import { AGENT_NAME, value as fmt } from '@/lib/format';

/** Who acts: one of the three agents, or any person in the company (every authority check still applies). */
export function ActorSelect({ id, value, onChange, label = 'Acting as' }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  const { people } = useDesk();
  const withAuthority = people.filter((p) => p.active && p.authority.length);
  const others = people.filter((p) => !(p.active && p.authority.length));
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <optgroup label="Agents">
          {Object.entries(AGENT_NAME).map(([aid, name]) => (
            <option key={aid} value={aid}>
              {name}
            </option>
          ))}
        </optgroup>
        {withAuthority.length ? (
          <optgroup label="People with approval authority">
            {withAuthority.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}, {p.title} ({p.authority.map((a) => fmt(a.policy, a.cap)).join(', ')})
              </option>
            ))}
          </optgroup>
        ) : null}
        {others.length ? (
          <optgroup label="Everyone else">
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}, {p.title}
                {p.active ? '' : ' (departed)'}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

/** A person picker for rulings, ratifications and reversals. */
export function PersonSelect({
  id,
  value,
  onChange,
  label,
  policy,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** Lists people with authority for this policy first. */
  policy?: string;
}) {
  const { people } = useDesk();
  const capFor = (pid: string) => people.find((p) => p.id === pid)?.authority.find((a) => a.policy === policy)?.cap;
  const sorted = [...people].sort((a, b) => (capFor(b.id) ?? -1) - (capFor(a.id) ?? -1) || a.name.localeCompare(b.name));
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {sorted.map((p) => {
          const cap = capFor(p.id);
          return (
            <option key={p.id} value={p.id}>
              {p.name}, {p.title}
              {cap != null && policy ? ` (may approve ${fmt(policy, cap)})` : ''}
              {p.active ? '' : ' (departed)'}
            </option>
          );
        })}
      </select>
    </label>
  );
}
