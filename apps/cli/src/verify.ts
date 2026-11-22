import { readFileSync, existsSync } from 'node:fs';
import { bindingReport } from '@hermes/id';
import { discoveryFromArgs } from './id.js';

/** hermes id verify <npub | name@domain | cashaddr | event.json> */
export async function verifyCmd(input?: string) {
  if (!input) throw new Error('usage: hermes id verify <npub|name@domain|cashaddr|event.json>');
  let event;
  if (existsSync(input)) event = JSON.parse(readFileSync(input, 'utf8'));
  else {
    const d = discoveryFromArgs();
    const r = await d.resolve(input);
    d.close();
    if (!r.identity) throw new Error(r.error ?? 'not found');
    event = r.identity.current.event;
    console.log(`resolved from ${r.answered} relay(s); warnings: ${r.identity.warnings.map((w) => w.message).join(' | ') || 'none'}`);
  }
  const rep = bindingReport(event);
  for (const s of rep.steps) console.log(`${s.ok ? '✔' : '✘'} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`);
  console.log(rep.ok ? `VALID (${rep.versions} version(s))` : 'INVALID');
  if (!rep.ok) process.exitCode = 2;
}
