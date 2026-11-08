import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './components';
import { setTheme, getTheme, type ThemePreference } from './theme';

const OPTIONS: { id: ThemePreference; label: string; icon: 'system' | 'sun' | 'moon' }[] = [
  { id: 'system', label: 'Use system setting', icon: 'system' },
  { id: 'light', label: 'Light theme', icon: 'sun' },
  { id: 'dark', label: 'Dark theme', icon: 'moon' },
];

/** A settings entry rather than a decorative sun/moon switch. */
export function ThemeMenu({ initial }: { initial: ThemePreference }) {
  const [value, setValue] = useState<ThemePreference>(initial);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, []);
  const Active = Icon[OPTIONS.find((o) => o.id === value)!.icon];
  return (
    <div className="theme-menu" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} aria-label="Appearance settings">
        <Active /><span className="tiny">Appearance</span><Icon.down />
      </button>
      {open && <div className="theme-popover" role="menu">
        {OPTIONS.map((o) => {
          const G = Icon[o.icon];
          return <button key={o.id} role="menuitemradio" aria-checked={value === o.id}
            className={value === o.id ? 'on' : ''}
            onClick={() => { setTheme(o.id); setValue(o.id); setOpen(false); }}>
            <G />{o.label}{value === o.id && <Icon.check style={{ marginLeft: 'auto' }} />}
          </button>;
        })}
      </div>}
    </div>
  );
}
