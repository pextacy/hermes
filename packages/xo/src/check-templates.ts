// Imports the Hermes templates into a throwaway XO engine (in-memory, chipnet) and checks that
// every starting action creates an invitation and reports its requirements. Uses the public
// XO test mnemonic from the engine playground — never fund it.
import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { StorageType } from '@xo-cash/state';
import { hermesHtlcTemplate } from './templates/htlc.js';
import { hermesIdentityTemplate } from './templates/identity.js';
import { hermesDropsClaimTemplate } from './templates/drops-claim.js';
import { p2pkhTemplate, multisigTemplate } from '@xo-cash/templates';

const TEST_MNEMONIC = 'page pencil stock planet limb cluster assault speak off joke private pioneer';
const engine = await Engine.create(TEST_MNEMONIC, {
  network: XO_SUPPORTED_NETWORKS.chipnet,
  storageType: StorageType.INDEXEDDB,
  databasePath: process.env.TMPDIR ?? '/tmp',
  databaseFilename: `xo-check-${Date.now()}`,
});
let failed = false;
for (const t of [...(process.argv.includes('--official') ? [p2pkhTemplate, multisigTemplate] : []), hermesHtlcTemplate, hermesIdentityTemplate, hermesDropsClaimTemplate]) {
  try {
    const { templateIdentifier } = await engine.importTemplate(t);
    console.log(`imported ${t.name}: ${templateIdentifier}`);
    for (const start of t.start) {
      const inv = await engine.createInvitation({ templateIdentifier, actionIdentifier: start.action, intent: start });
      const id = inv.invitation.invitationIdentifier;
      const missing = await engine.listMissingRequirements(id);
      console.log(`  ${start.action}: invitation ${id}, missing ${JSON.stringify(missing)}`);
    }
  } catch (error) {
    failed = true;
    console.error(`FAILED ${t.name}:`, error);
  }
}
await engine.stop();
process.exit(failed ? 1 : 0);
