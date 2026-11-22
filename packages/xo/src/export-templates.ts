// Writes the templates as JSON files (for the XO debug tool https://blaze.xo.cash/ and other wallets).
import { writeFileSync } from 'node:fs';
import { hermesHtlcTemplate } from './templates/htlc.js';
import { hermesIdentityTemplate } from './templates/identity.js';
import { hermesDropsClaimTemplate } from './templates/drops-claim.js';
const out = (name: string, t: unknown) => {
  writeFileSync(new URL(`../templates/${name}.json`, import.meta.url), JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2) + '\n');
  console.log(`templates/${name}.json`);
};
out('hermes-htlc', hermesHtlcTemplate);
out('hermes-identity', hermesIdentityTemplate);
out('hermes-drops-claim', hermesDropsClaimTemplate);
