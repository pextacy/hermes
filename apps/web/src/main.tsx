import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { toast } from './components/Toast';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * G38: register the app-shell service worker (production builds only; dist/sw.js is emitted by vite.config.ts).
 * Relative URL so it works at a domain root, a subpath or IPFS gateway; scope is the app's own directory.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator && /^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(location.href)) {
  const register = () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register('sw.js', { scope: './' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          w?.addEventListener('statechange', () => {
            if (w.state !== 'activated') return;
            toast(hadController ? 'Hermes was updated — reload to use the new version' : 'Hermes is ready to work offline', 'info');
          });
        });
      })
      .catch((e: unknown) => {
        // No worker (private mode, blocked): the app still works online.
        console.info('Hermes: offline support unavailable —', (e as Error)?.message ?? e);
      });
  };
  // Large modules (wasm init) can finish evaluating after `load` has already fired.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
