// SPDX-License-Identifier: GPL-2.0-only
// Small controls shared by the shell and the views.
import { useState, type ReactNode } from 'react';
import type { Prefs } from './util';

// A number box that applies on Enter or when leaving the field (not on every keystroke).
export function NumField({ value, onCommit, title, label }: { value: number; onCommit: (v: number) => void; title: string; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    const v = Number(text);
    if (text !== null && text.trim() !== '' && Number.isFinite(v)) onCommit(v);
    setText(null);
  };
  return (
    <input
      className="num"
      aria-label={label}
      value={text ?? String(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      title={title}
    />
  );
}

// Segmented buttons: one of a few values.
export function Seg<T extends string>(p: {
  value: T; options: [T, ReactNode][]; onChange: (v: T) => void; disabled?: boolean; wide?: boolean; title?: string;
}) {
  return (
    <div className={p.wide ? 'seg wide' : 'seg'} role="group" title={p.title}>
      {p.options.map(([v, label]) => (
        <button key={v} className={v === p.value ? 'on' : ''} aria-pressed={v === p.value} disabled={p.disabled} onClick={() => p.onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// A sidebar section that folds to its heading (and a one-line summary); the folded ones are remembered.
export function Section(p: {
  id: string; title: string; summary?: ReactNode; children: ReactNode;
  prefs: Prefs; updatePrefs: (x: Partial<Prefs>) => void;
}) {
  const folded = p.prefs.collapsed.includes(p.id);
  const toggle = () =>
    p.updatePrefs({ collapsed: folded ? p.prefs.collapsed.filter((x) => x !== p.id) : [...p.prefs.collapsed, p.id] });
  return (
    <section className="sbsec">
      <button className="sbhead" aria-expanded={!folded} onClick={toggle}>
        <span className={folded ? 'chev' : 'chev open'} aria-hidden="true">
          ›
        </span>
        {p.title}
      </button>
      {folded ? p.summary && <span className="note">{p.summary}</span> : p.children}
    </section>
  );
}
