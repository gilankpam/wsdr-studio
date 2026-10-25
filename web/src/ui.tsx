// SPDX-License-Identifier: GPL-2.0-only
// Small controls shared by the shell and the views.
import { useState, type ReactNode } from 'react';

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
