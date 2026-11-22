/**
 * Hermes XO HTLC — one command per party step. Each party uses its own XO wallet (BIP39
 * mnemonic typed at runtime) and its own local database; invitations travel as files.
 *
 *   initiator:    tsx src/cli.ts create  --hashlock <hex> --timeout <unix> (--sats N | --token <cat> --amount A) --out inv1.json
 *   counterparty: tsx src/cli.ts join    --in inv1.json --out inv2.json
 *   initiator:    tsx src/cli.ts fund    --in inv2.json [--broadcast]
 *   counterparty: tsx src/cli.ts claim   --secret <hex> (--sats N | --token <cat> --amount A) [--broadcast]
 *   initiator:    tsx src/cli.ts refund  (--sats N | --token <cat> --amount A) [--broadcast]
 *   anyone:       tsx src/cli.ts inspect --in inv.json [--network mainnet]   # decode + XO validation issues
 *   initiator:    tsx src/cli.ts secret          # new 32-byte secret and its SHA-256 hashlock (keep the secret)
 * Common: --network chipnet|mainnet (mainnet needs --i-have-owner-approval), --db <name>.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { counterpartyJoin, exportInvitation, followUp, importHermesTemplates, importInvitation, initiatorCreateLock, initiatorFundAndExecute, openEngine } from './flow.js';
import { describeInvitation, listInvitationIssues } from './inspect.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n: string) => args.includes(`--${n}`);
const network = (opt('network', 'chipnet') as 'chipnet' | 'mainnet');
// Read-only commands (inspect, secret) never touch a wallet, so they need no approval.
if (network === 'mainnet' && !flag('i-have-owner-approval') && cmd !== 'inspect' && cmd !== 'secret') {
  console.error('Mainnet needs the owner’s explicit approval in chat (CLAUDE.md).');
  process.exit(1);
}

async function mnemonic(): Promise<string> {
  let muted = false;
  const out = new Writable({ write(c, _e, cb) { if (!muted) process.stdout.write(c); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  process.stdout.write('XO wallet mnemonic: ');
  muted = true;
  const a = await new Promise<string>((r) => rl.question('', r));
  rl.close();
  process.stdout.write('\n');
  return a.trim();
}

const amounts = () => (opt('token') ? { token: { category: opt('token')!, amount: BigInt(opt('amount', '0')!) } } : { lockedSatoshis: Number(opt('sats', '10000')) });
const followVars = () => (opt('token') ? { lockedTokenCategory: opt('token')!, lockedTokenAmount: BigInt(opt('amount', '0')!) } : { lockedSatoshis: BigInt(opt('sats', '10000')!) });

let exitCode = 0;
const WALLET_COMMANDS = ['create', 'join', 'fund', 'claim', 'refund'];
const HEX32 = /^[0-9a-f]{64}$/i;

/** Argument errors are reported before the mnemonic prompt, so nobody types a mnemonic for nothing. */
function argumentErrors(): string[] {
  const e: string[] = [];
  const need = (n: string) => {
    if (!opt(n)) e.push(`--${n} is required`);
  };
  if (cmd === 'create') {
    if (!HEX32.test(opt('hashlock') ?? '')) e.push('--hashlock must be 32 bytes of hex (SHA-256 of the secret; `secret` makes one)');
    if (!/^\d+$/.test(opt('timeout') ?? '') || Number(opt('timeout')) < 500_000_000) e.push('--timeout must be a unix timestamp in seconds');
  }
  if (cmd === 'claim' && !HEX32.test(opt('secret') ?? '')) e.push('--secret must be the 32-byte secret in hex');
  if (cmd === 'join' || cmd === 'fund' || cmd === 'inspect') need('in');
  if (opt('token') !== undefined && !HEX32.test(opt('token')!)) e.push('--token must be a 32-byte token category in hex');
  if (opt('sats') !== undefined && !/^\d+$/.test(opt('sats')!)) e.push('--sats must be an integer');
  if (opt('amount') !== undefined && !/^\d+$/.test(opt('amount')!)) e.push('--amount must be an integer (base units)');
  return e;
}

const usage = () => console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 12).join('\n'));

async function main() {
  const bad = argumentErrors();
  if (bad.length) {
    for (const m of bad) console.error(m);
    exitCode = 1;
    return;
  }
  if (cmd === 'secret') {
    const secret = randomBytes(32);
    console.log(`secret   ${secret.toString('hex')}   (keep private until you claim)`);
    console.log(`hashlock ${createHash('sha256').update(secret).digest('hex')}   (share; use with --hashlock)`);
    return;
  }
  if (cmd === 'inspect') {
    const data = readFileSync(opt('in')!, 'utf8');
    const v = describeInvitation(data);
    const issues = await listInvitationIssues(data, network);
    console.log(JSON.stringify({ ...v, network, issues }, null, 2));
    if (!v.pinned) console.warn('WARNING: not a Hermes template — do not sign.');
    else if (issues.length) console.warn(`WARNING: ${issues.length} validation issue(s) on ${network} — do not sign.`);
    if (!v.pinned || issues.length) exitCode = 2;
    return;
  }
  if (!WALLET_COMMANDS.includes(cmd)) {
    usage();
    return;
  }
  const engine = await openEngine(await mnemonic(), { network, databaseFilename: opt('db', `hermes-xo-${network}`) });
  try {
    const { htlc } = await importHermesTemplates(engine);
    if (cmd === 'create') {
      const s = await initiatorCreateLock(engine, htlc, { hashlock: opt('hashlock')!, timeout: Number(opt('timeout')), ...amounts() });
      writeFileSync(opt('out', 'inv1.json')!, exportInvitation(s.invitation));
      console.log(`invitation ${s.invitation.invitationIdentifier} → ${opt('out', 'inv1.json')} (send it to the counterparty)`);
    } else if (cmd === 'join') {
      const s = await counterpartyJoin(engine, htlc, importInvitation(readFileSync(opt('in')!, 'utf8')));
      writeFileSync(opt('out', 'inv2.json')!, exportInvitation(s.invitation));
      console.log(`joined as counterparty → ${opt('out', 'inv2.json')} (send it back)`);
    } else if (cmd === 'fund') {
      const r = await initiatorFundAndExecute(engine, htlc, importInvitation(readFileSync(opt('in')!, 'utf8')), { broadcast: flag('broadcast') });
      console.log(`HTLC locking bytecode ${r.lockingBytecode}`);
      console.log(JSON.stringify(r.result, (_k, v) => (typeof v === 'bigint' ? `${v}` : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v), 2));
    } else if (cmd === 'claim' || cmd === 'refund') {
      const action = (cmd + (opt('token') ? 'Tokens' : '')) as 'claim' | 'claimTokens' | 'refund' | 'refundTokens';
      const vars: Record<string, unknown> = { ...followVars() };
      if (cmd === 'claim') vars.secret = opt('secret');
      const r = await followUp(engine, htlc, action, vars, { broadcast: flag('broadcast') });
      console.log(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}` : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v), 2));
    }
  } finally {
    await engine.stop();
  }
}
main().then(() => process.exit(exitCode), (e) => { console.error(e); process.exit(1); });
