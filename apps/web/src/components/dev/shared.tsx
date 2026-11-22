import { useState } from 'react';

export function downloadText(name: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** Copy button that says "copied" for a moment (falls back silently without clipboard access). */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

/** Label + monospace value that wraps, with a copy button. */
export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="dev-field">
      <div className="dev-field-head">
        <span>{label}</span>
        <CopyButton text={value} />
      </div>
      <code className="dev-value">{value}</code>
    </div>
  );
}
