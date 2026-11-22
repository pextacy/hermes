/**
 * pnpm check:submission — the BCH BLAZE submission checklist (docs/PHASES.md → "Submission checklist"),
 * checked from the repo. Every line maps to a real check: config values, deployment records, files on disk,
 * a secret scan, or an owner attestation in config/submission.json (things only a person can confirm:
 * Telegram, roll call, the XO feedback they wrote, the media piece).
 *
 *   pnpm check:submission            informational, exit 0
 *   pnpm check:submission --strict   exit 1 while a required item is open
 *   pnpm check:submission --json     machine-readable rows
 *   pnpm check:submission --run-tests  also runs `pnpm test`
 *
 * Reads files only (no keys, no network).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeCashAddress } from '@bitauth/libauth';

export interface Row {
  section: string;
  item: string;
  ok: boolean;
  required: boolean;
  hint?: string;
}

/** Owner-confirmed facts (config/submission.json). Agents never set these. */
export interface Attestations {
  liveDemoUrl?: string | null;
  mainnetDemoTxids?: string[];
  telegramConfirmed?: boolean;
  rollCall?: string | null;
  xoFeedbackWrittenByOwner?: boolean;
  mediaUrl?: string | null;
  bountyDeliverables?: Record<string, boolean>;
}

const isHttps = (u: unknown) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);
const isTxid = (t: unknown) => typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t);

/** A token-aware mainnet cashaddr (`bitcoincash:z…` / `r…`) — CashTokens can only be sent to these. */
export function isTokenAwareMainnetAddress(a: unknown): boolean {
  if (typeof a !== 'string' || !a.startsWith('bitcoincash:')) return false;
  const d = decodeCashAddress(a);
  return typeof d === 'object' && /WithTokens$/.test(d.type);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'cache', 'broadcast', 'coverage', '.vite', 'data', 'artifacts']);
const SKIP_PATHS = new Set(['packages/evm-htlc/lib']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|toml|ya?ml|sol|cash|scash|txt|sh|html|css)$|^\.env/;
const SECRET_PATTERNS: [string, RegExp][] = [
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Nostr nsec', /\bnsec1[02-9ac-hj-np-z]{58}\b/],
  ['BCH WIF private key', /(?<![A-Za-z0-9])[KL][1-9A-HJ-NP-Za-km-z]{51}(?![A-Za-z0-9])/],
  ['BIP-39 mnemonic field', /"(mnemonic|seed ?phrase)"\s*:\s*"(\w+ ){11,23}\w+"/i],
];

/** Files under `root` that look like they contain a private key, plus any .env file. */
export function scanSecrets(root: string): { file: string; what: string }[] {
  const hits: { file: string; what: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !SKIP_PATHS.has(relative(root, p))) walk(p, depth + 1);
        continue;
      }
      if (/^\.env(\.|$)/.test(name)) {
        hits.push({ file: relative(root, p), what: '.env file' });
        continue;
      }
      if (!TEXT.test(name) || st.size > 2_000_000) continue;
      const text = readFileSync(p, 'utf8');
      for (const [what, re] of SECRET_PATTERNS) if (re.test(text)) hits.push({ file: relative(root, p), what });
    }
  };
  walk(root, 0);
  return hits;
}

/** All checklist rows for the repo at `root`. Pure apart from reading files. */
export function collectChecks(root: string, opts: { scan?: boolean } = {}): Row[] {
  const at = (p: string) => join(root, p);
  const has = (p: string) => existsSync(at(p));
  const json = <T,>(p: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(at(p), 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hermes = json<any>('config/hermes.json', {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nets = json<any>('config/networks.json', {});
  const att = json<Attestations>('config/submission.json', {});
  const rows: Row[] = [];
  let section = '';
  const check = (item: string, ok: boolean, required = true, hint?: string) => rows.push({ section, item, ok: !!ok, required, hint });
  const attest = 'owner sets this in config/submission.json';

  section = 'Banner (top of the live demo)';
  const b = hermes?.web?.banner ?? {};
  check('Widget Factory presentation link (final, not draft)', isHttps(b.presentationUrl) && b.presentationIsDraft === false, true, 'config/hermes.json → web.banner.presentationUrl, presentationIsDraft=false');
  check('Repository link', isHttps(b.repoUrl), true, 'config/hermes.json → web.banner.repoUrl (after the owner approves pushing)');
  check('EMBER2026 CashTokens address (token-aware bitcoincash:z…)', isTokenAwareMainnetAddress(b.ember2026Address), true, 'config/hermes.json → web.banner.ember2026Address');
  check('Banner component renders these values', has('apps/web/src/components/Banner.tsx'), true, 'apps/web/src/components/Banner.tsx');

  section = 'Live demo';
  check('Live demo link', isHttps(att.liveDemoUrl), true, `liveDemoUrl — ${attest} after deploying apps/web/dist`);
  const dist = has('apps/web/dist/index.html') ? readFileSync(at('apps/web/dist/index.html'), 'utf8') : '';
  check('Production build present (apps/web/dist)', !!dist, false, 'pnpm --filter web build');
  check('Build uses relative asset paths (works at a sub-path)', !!dist && /src="\.\/assets\//.test(dist) && !/src="\/assets\//.test(dist), false, "vite.config.ts base: './' then rebuild");
  const headersFile = has('apps/web/public/_headers') ? readFileSync(at('apps/web/public/_headers'), 'utf8') : '';
  const vercel = json<{ headers?: unknown[] }>('apps/web/vercel.json', {});
  check(
    'Static hosting config (netlify.toml, public/_headers with CSP, vercel.json headers)',
    has('apps/web/netlify.toml') && /Content-Security-Policy:/.test(headersFile) && Array.isArray(vercel.headers) && vercel.headers.length > 0,
    true,
    'apps/web/netlify.toml + apps/web/public/_headers + apps/web/vercel.json',
  );

  section = 'Mainnet';
  check('Mainnet PUSD category configured', !!nets?.bch?.mainnet?.tokens?.PUSD?.category, true, 'config/networks.json → bch.mainnet.tokens.PUSD.category');
  check('Web Pay tab targets mainnet', hermes?.web?.payNetwork === 'mainnet', true, 'config/hermes.json → web.payNetwork');
  check('Mainnet tx usable by judges (txid recorded)', Array.isArray(att.mainnetDemoTxids) && att.mainnetDemoTxids.length > 0 && att.mainnetDemoTxids.every(isTxid), true, `mainnetDemoTxids — ${attest} (owner-approved broadcast)`);

  section = 'Integrations';
  const webPkg = json<{ dependencies?: Record<string, string> }>('apps/web/package.json', {});
  check('WizardConnect wallet connection in the web app', !!webPkg.dependencies?.['@wizardconnect/react'] && has('apps/web/src/lib/wizard.ts'), true, 'apps/web/src/lib/wizard.ts + @wizardconnect/react');
  check('XO templates exported', ['hermes-htlc', 'hermes-identity', 'hermes-drops-claim'].every((t) => has(`packages/xo/templates/${t}.json`)), true, 'pnpm --filter @hermes/xo export');

  section = 'Bounty deliverables';
  check('Test stablecoin minted (chipnet or testnet4)', !!(nets?.bch?.chipnet?.tokens?.PUSD?.category || nets?.bch?.testnet4?.tokens?.PUSD?.category), true, 'pnpm --filter solver mint-test-tokens -- --network chipnet');
  check('EVM HTLC deployed (Base Sepolia)', !!nets?.evm?.baseSepolia?.htlc, true, 'pnpm --filter cli hermes evm deploy --evm baseSepolia');
  check('Drops testnet deployment record (chipnet or testnet4)', has('packages/drops/deployments/chipnet.json') || has('packages/drops/deployments/testnet4.json'), true, 'pnpm --filter @hermes/drops exec tsx src/cli.ts deploy --network chipnet');
  const dropsDir = at('packages/drops/deployments');
  check('Drops epoch trees built', existsSync(dropsDir) && readdirSync(dropsDir).some((f) => /^tree-\d+\.json$/.test(f)), true, 'pnpm --filter @hermes/drops exec tsx src/cli.ts tree');
  check('SolidCash mainnet lifecycle recorded', has('packages/solid/deployments/mainnet.json'), true, 'pnpm --filter @hermes/solid lifecycle -- --network mainnet --i-have-owner-approval');
  check('XO feedback (~500 words, written by the owner personally)', att.xoFeedbackWrittenByOwner === true, true, `xoFeedbackWrittenByOwner — ${attest}; never generated`);
  for (const [k, v] of Object.entries(att.bountyDeliverables ?? {})) check(`Bounty deliverable: ${k}`, v === true, true, attest);

  section = 'Community';
  check('Project confirmed in the BCH BLAZE Telegram', att.telegramConfirmed === true, true, `telegramConfirmed — ${attest}`);
  check('Roll-call situation handled', typeof att.rollCall === 'string' && att.rollCall.trim().length > 0, true, `rollCall (one line: team joined / organisers' answer) — ${attest}`);
  check('Media-track piece published (owner-made)', isHttps(att.mediaUrl), false, `mediaUrl — ${attest}`);

  section = 'Hygiene';
  if (opts.scan !== false) {
    const hits = scanSecrets(root);
    check('No secrets in the repo (.env, WIF, nsec, PEM, mnemonic)', hits.length === 0, true, hits.slice(0, 5).map((h) => `${h.file} (${h.what})`).join(', '));
  }
  return rows;
}

export function format(rows: Row[]): string {
  const out: string[] = [];
  let section = '';
  for (const r of rows) {
    if (r.section !== section) {
      section = r.section;
      out.push(`\n${section}`);
    }
    const mark = r.ok ? '✔' : r.required ? '✘' : '·';
    out.push(`  ${mark} ${r.item}${!r.ok && r.hint ? `\n      → ${r.hint}` : ''}`);
  }
  const open = rows.filter((r) => r.required && !r.ok).length;
  const done = rows.filter((r) => r.ok).length;
  out.push(`\n${done}/${rows.length} done${open ? ` · ${open} required item(s) open` : ' · all required items done'}  (✔ done  ✘ required, open  · optional)`);
  return out.join('\n');
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const rows = collectChecks(root);
  if (process.argv.includes('--run-tests')) {
    let ok = true;
    try {
      execSync('pnpm test', { cwd: root, stdio: 'inherit' });
    } catch {
      ok = false;
    }
    rows.push({ section: 'Tests', item: 'All test suites green (vitest + forge + solidhat)', ok, required: true, hint: 'pnpm test' });
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.log(format(rows));
  if (process.argv.includes('--strict') && rows.some((r) => r.required && !r.ok)) process.exit(1);
}
