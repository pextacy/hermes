import { useEffect, useRef } from 'react';
import { SHORTCUTS, nextTheme, type ThemePref } from '../lib/shell';

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_ICON: Record<ThemePref, string> = { system: '◐', light: '☀', dark: '☾' };

/** G36: header button cycling system → light → dark. */
export function ThemeToggle({ theme, onChange }: { theme: ThemePref; onChange: (t: ThemePref) => void }) {
  const next = nextTheme(theme);
  return (
    <button
      className="theme-btn"
      onClick={() => onChange(next)}
      title={`Theme: ${THEME_LABEL[theme]} — switch to ${THEME_LABEL[next]}`}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}`}
    >
      <span aria-hidden="true">{THEME_ICON[theme]}</span>
    </button>
  );
}

/** G36: the same choice as a segmented control (Settings tab). */
export function ThemeChooser({ theme, onChange }: { theme: ThemePref; onChange: (t: ThemePref) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => onChange(t)}>
          {THEME_ICON[t]} {THEME_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

const TAB_LABEL: Record<string, string> = { pay: 'Pay', identity: 'Identity', swap: 'Swap', claims: 'Claims', developers: 'Developers', settings: 'Settings' };

/** G37: keyboard-shortcut help, a native modal <dialog> (focus is trapped and Esc closes it). */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="shortcuts"
      aria-labelledby="shortcuts-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="shortcuts-body">
        <div className="card-head">
          <h3 id="shortcuts-title">Keyboard shortcuts</h3>
          <button className="small" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <table className="table">
          <tbody>
            {Object.entries(SHORTCUTS).map(([k, tab]) => (
              <tr key={k}>
                <td>
                  <kbd>g</kbd> then <kbd>{k}</kbd>
                </td>
                <td>Go to {TAB_LABEL[tab] ?? tab}</td>
              </tr>
            ))}
            <tr>
              <td>
                <kbd>?</kbd>
              </td>
              <td>Show this help</td>
            </tr>
            <tr>
              <td>
                <kbd>Esc</kbd>
              </td>
              <td>Close</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">Shortcuts are ignored while you type in a field.</p>
      </div>
    </dialog>
  );
}

/** G41: first focusable element; moves focus to <main> without touching the hash (routing is hash-based). */
export function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(e) => {
        e.preventDefault();
        const m = document.getElementById('main-content');
        m?.focus();
        m?.scrollIntoView();
      }}
    >
      Skip to content
    </a>
  );
}
