/**
 * Hermes Solid lifecycle CLI: lock → claim, and lock → refund, for the SolidCash-compiled HTLC.
 *
 *   tsx src/lifecycle.ts                       # mock network (default), full VM evaluation
 *   tsx src/lifecycle.ts --network chipnet     # key prompted at runtime
 *   tsx src/lifecycle.ts --network mainnet --i-have-owner-approval   # dust amounts only
 *   --path claim|refund    run one HTLC path only (default: both)
 *   --ledger               also run the stateful HermesSwapLedger (deploy → record → replay refused → state/event)
 *
 * On live networks the transactions are written to deployments/<network>.json (no keys), which
 * the web app's Developers tab shows.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { decodePrivateKeyWif, hexToBin, binToHex } from '@bitauth/libauth';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { party, runLedgerDemo, runSolidLifecycle, type DeploymentRecord, type HtlcPath, type LifecycleStep } from './lifecycle-core.js';

const args = process.argv.slice(2);
const network = (args.includes('--network') ? args[args.indexOf('--network') + 1] : 'mock') as 'mock' | 'chipnet' | 'mainnet';
if (network === 'mainnet' && !args.includes('--i-have-owner-approval')) {
  console.error('Mainnet needs the owner’s explicit approval in chat (CLAUDE.md).');
  process.exit(1);
}
const keyFrom = (s: string) => {
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBin(s);
  const d = decodePrivateKeyWif(s);
  if (typeof d === 'string') throw new Error(d);
  return d.privateKey;
};
const ask = async (q: string) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const a = await new Promise<string>((r) => rl.question(q, r));
  rl.close();
  return a.trim();
};

const pathArg = args.includes('--path') ? args[args.indexOf('--path') + 1] : undefined;
if (pathArg && pathArg !== 'claim' && pathArg !== 'refund') {
  console.error('--path must be claim or refund');
  process.exit(1);
}
const paths = pathArg ? [pathArg as HtlcPath] : undefined;
const withLedger = args.includes('--ledger');

const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const mock = network === 'mock';
const provider: any = mock ? new MockNetworkProvider() : new ElectrumNetworkProvider(network);
const locker = party(mock ? randomBytes(32) : keyFrom(await ask(`Funding key (WIF/hex) for ${network}: `)), prefix);
const recipient = party(randomBytes(32), prefix);
if (!mock) console.log(`recipient demo key (keep it to recover a claim): ${binToHex(recipient.priv)}`);
const print = (s: LifecycleStep) => console.log(`[${s.path}] ${s.ok ? '✔' : '✘'} ${s.step.padEnd(12)} ${s.txid ?? s.address ?? ''}  ${s.note}`);
const lockSats = network === 'mainnet' ? 3_000n : 10_000n;
const steps = await runSolidLifecycle({
  provider,
  mock,
  prefix,
  locker,
  recipient,
  lockSats,
  now: Math.floor(Date.now() / 1000),
  paths,
  onStep: print,
});
if (withLedger) steps.push(...(await runLedgerDemo({ provider, mock, operatorKey: locker.priv, onStep: print })));
if (!mock) {
  const record: DeploymentRecord = {
    network,
    at: new Date().toISOString(),
    contract: 'HermesHtlc.scash',
    contracts: withLedger ? ['HermesHtlc.scash', 'HermesSwapLedger.scash'] : ['HermesHtlc.scash'],
    lockSats: `${lockSats}`,
    steps,
  };
  writeFileSync(new URL(`../deployments/${network}.json`, import.meta.url), JSON.stringify(record, null, 2) + '\n');
  console.log(`recorded in packages/solid/deployments/${network}.json`);
}
process.exit(steps.every((s) => s.ok) ? 0 : 1);
