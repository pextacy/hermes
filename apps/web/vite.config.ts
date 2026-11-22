import { defineConfig, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

/**
 * G38: builds src/sw/sw.ts into dist/sw.js (a classic script with no imports) and fills in the app-shell
 * precache list — index.html, the entry chunk with its static imports and CSS, the manifest, icons and
 * theme-init.js. Lazy tab chunks are cached on first use by the worker itself. Build only; dev has no worker.
 */
function hermesServiceWorker(): Plugin {
  const swEntry = fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url));
  return {
    name: 'hermes-sw',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: swEntry, fileName: 'sw.js' });
    },
    generateBundle(_opts, bundle: OutputBundle) {
      const sw = bundle['sw.js'] as OutputChunk | undefined;
      if (!sw) return this.error('sw.js was not emitted');
      if (/^\s*import\b|\bimport\s*\(|^export\b/m.test(sw.code)) this.error('sw.js must be standalone (no imports/exports)');
      const files = new Set<string>(['index.html', 'manifest.webmanifest', 'hermes.svg', 'icon-192.png', 'icon-512.png', 'theme-init.js']);
      const walk = (name: string) => {
        const c = bundle[name];
        if (!c || files.has(name)) return;
        files.add(name);
        if (c.type !== 'chunk') return;
        const meta = (c as OutputChunk & { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }).viteMetadata;
        meta?.importedCss.forEach((f) => files.add(f));
        c.imports.forEach(walk);
      };
      for (const [name, c] of Object.entries(bundle)) if (c.type === 'chunk' && c.isEntry && name !== 'sw.js') walk(name);
      const list = [...files].sort();
      const version = createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
      sw.code = sw.code.replace(/(["'`])__HERMES_PRECACHE__\1/, JSON.stringify(list)).replace(/(["'`])__HERMES_SW_VERSION__\1/, JSON.stringify(version));
      if (sw.code.includes('__HERMES_')) this.error('sw.js placeholders were not replaced');
    },
  };
}

export default defineConfig({
  // Relative base: the build works at a domain root, a subpath (GitHub Pages) or IPFS. Routing is hash-based.
  base: './',
  plugins: [
    react(),
    hermesServiceWorker(),
    // The Developers-tab invitation viewer lazy-loads @xo-cash/engine for listInvitationValidationIssues only.
    // The engine bundle statically imports @xo-cash/state, whose Node storage backend (fs, path,
    // better-sqlite3) is never used in the browser; stub those imports so Rollup can bundle it.
    {
      name: 'xo-state-node-stubs',
      enforce: 'pre',
      resolveId(id, importer) {
        if (importer?.includes('@xo-cash/state') && ['fs', 'path', 'better-sqlite3'].includes(id)) return `\0xo-stub:${id}`;
      },
      load(id) {
        if (!id.startsWith('\0xo-stub:')) return;
        return `const unavailable = () => { throw new Error('Node storage is not available in the browser'); };
export const existsSync = () => false; export const mkdirSync = unavailable; export const join = (...p) => p.join('/');
export default unavailable;`;
      },
    },
  ],
  server: { fs: { allow: ['../..'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  esbuild: { target: 'es2022' },
  define: { 'process.env': {} },
});
