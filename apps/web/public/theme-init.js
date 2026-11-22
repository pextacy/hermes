// G36: apply the saved light/dark choice before first paint (a file, not inline: the CSP forbids inline scripts).
// "system" (or nothing saved) leaves <html> without data-theme, so styles.css follows prefers-color-scheme.
try {
  var t = JSON.parse(localStorage.getItem('hermes.theme') || '"system"');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  /* storage blocked: follow the system */
}
