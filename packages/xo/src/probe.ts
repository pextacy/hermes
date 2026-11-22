// Offline end-to-end probe of the two-party lock flow (one process per party, invitation
// passed as a serialized string through a temp file). Stops before funding.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateBip39Mnemonic } from '@bitauth/libauth';
import { openEngine, importHermesTemplates, initiatorCreateLock, counterpartyJoin, exportInvitation, importInvitation, checkIncoming } from './flow.js';
const [step, dir] = [process.argv[2], process.argv[3]];
const file = (n: string) => `${dir}/${n}`;
const TEST = 'page pencil stock planet limb cluster assault speak off joke private pioneer';
if (step === 'a1') {
  const e = await openEngine(TEST, { network: 'chipnet', databasePath: dir, databaseFilename: 'a' });
  const { htlc } = await importHermesTemplates(e);
  const s = await initiatorCreateLock(e, htlc, { hashlock: 'aa'.repeat(32), timeout: 1800000000, lockedSatoshis: 10000 });
  writeFileSync(file('inv1'), exportInvitation(s.invitation));
  console.log('A created', s.invitation.invitationIdentifier);
  await e.stop();
} else if (step === 'b') {
  writeFileSync(file('mnB'), generateBip39Mnemonic() as string);
  const e = await openEngine(readFileSync(file('mnB'), 'utf8'), { network: 'chipnet', databasePath: dir, databaseFilename: 'b' });
  const { htlc } = await importHermesTemplates(e);
  const s = await counterpartyJoin(e, htlc, importInvitation(readFileSync(file('inv1'), 'utf8')));
  writeFileSync(file('inv2'), exportInvitation(s.invitation));
  console.log('B joined; missing', JSON.stringify(await e.listMissingRequirements(s.invitation.invitationIdentifier)));
  await e.stop();
} else if (step === 'a2') {
  const e = await openEngine(TEST, { network: 'chipnet', databasePath: dir, databaseFilename: 'a' });
  const { htlc } = await importHermesTemplates(e);
  const inv = importInvitation(readFileSync(file('inv2'), 'utf8'));
  await checkIncoming(e, inv, [htlc]);
  let s = await e.updateInvitation(inv);
  const id = s.invitation.invitationIdentifier;
  s = await e.appendInvitation(id, { outputs: [{ outputIdentifier: 'htlcOutput' }] } as never);
  console.log('A merged; missing', JSON.stringify(await e.listMissingRequirements(id)));
  console.log('HTLC locking bytecode', await e.resolveInvitationOutputLockingBytecode(id, 'htlcOutput', 'initiator'));
  await e.stop();
}
process.exit(0);
