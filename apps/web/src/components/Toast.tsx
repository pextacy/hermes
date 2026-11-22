import { useEffect, useRef, useState } from 'react';
import { defaultTtl, dropToast, pushToast, type Toast, type ToastKind } from '../lib/shell';

/**
 * G39: toast notifications for finished async actions.
 *
 *   import { useToast } from '../components/Toast';
 *   const toast = useToast();
 *   toast('Payment sent', 'ok');                 // kind: ok | info | warn | err (default info)
 *   toast('Relay timed out', 'err', { ttl: 0 }); // ttl 0 = stays until dismissed
 *
 * `toast` is also exported for code outside React (e.g. the service-worker registration). Calls made
 * before <Toaster/> mounts are queued. Without a mounted <Toaster/> they are harmless no-ops.
 */
export interface ToastOptions {
  ttl?: number;
}
type Sink = (t: Toast) => void;
let sink: Sink | null = null;
let queue: Toast[] = [];
let nextId = 1;

export function toast(text: string, kind: ToastKind = 'info', opts: ToastOptions = {}): number {
  const t: Toast = { id: nextId++, text, kind, ttl: opts.ttl ?? defaultTtl(kind) };
  if (sink) sink(t);
  else queue = pushToast(queue, t);
  return t.id;
}

/** Stable function; safe to call in any component, effect or async callback. */
export const useToast = () => toast;

const ICON: Record<ToastKind, string> = { ok: '✔', info: 'ℹ', warn: '!', err: '✘' };

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const dismiss = (id: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      setList((l) => dropToast(l, id));
    };
    sink = (t) => {
      setList((l) => pushToast(l, t));
      if (t.ttl > 0) timers.current.set(t.id, setTimeout(() => dismiss(t.id), t.ttl));
    };
    const pending = queue;
    queue = [];
    pending.forEach((t) => sink!(t));
    return () => {
      sink = null;
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, []);
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {/* Two live regions: errors are announced assertively, everything else politely. */}
      <div aria-live="polite" aria-atomic="false" className="toasts-col">
        {list
          .filter((t) => t.kind !== 'err')
          .map((t) => (
            <ToastItem key={t.id} t={t} onClose={() => setList((l) => dropToast(l, t.id))} />
          ))}
      </div>
      <div aria-live="assertive" aria-atomic="false" className="toasts-col">
        {list
          .filter((t) => t.kind === 'err')
          .map((t) => (
            <ToastItem key={t.id} t={t} onClose={() => setList((l) => dropToast(l, t.id))} />
          ))}
      </div>
    </div>
  );
}

function ToastItem({ t, onClose }: { t: Toast; onClose: () => void }) {
  return (
    <div className={`toast toast-${t.kind}`}>
      <span className="toast-icon" aria-hidden="true">
        {ICON[t.kind]}
      </span>
      <span className="toast-text">{t.text}</span>
      <button className="toast-x" onClick={onClose} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}
