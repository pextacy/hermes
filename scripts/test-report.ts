/**
 * G31 — test report for the web app's Developers tab.
 *   pnpm tsx scripts/test-report.ts                  run vitest (JSON reporter) and write the report
 *   pnpm tsx scripts/test-report.ts --from out.json  summarise an existing vitest JSON file instead
 * Writes apps/web/src/generated/test-report.json (committed; the app imports it at build time).
 * Exits non-zero only if vitest produced no JSON; failing tests are recorded, not hidden.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeVitest } from '../apps/web/src/lib/devtools';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps/web/src/generated/test-report.json');
const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);

let jsonPath = arg('from');
if (!jsonPath) {
  jsonPath = join(mkdtempSync(join(tmpdir(), 'hermes-tests-')), 'vitest.json');
  const extra = process.argv.slice(2).filter((a) => a.startsWith('tests/'));
  const r = spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${jsonPath}`, ...extra], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`vitest exited with ${r.status}`);
}
if (!existsSync(jsonPath)) {
  console.error(`no vitest JSON at ${jsonPath}`);
  process.exit(1);
}
const report = summarizeVitest(JSON.parse(readFileSync(jsonPath, 'utf8')), root);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const t = report.totals;
console.log(`${t.suites} suites · ${t.tests} tests · ${t.passed} passed · ${t.failed} failed · ${t.skipped} skipped → ${out}`);
