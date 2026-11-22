import { defineConfig } from '@solidcash/solidhat/config';

// SolidHat project config for Hermes Solid. Tests run on the in-process mock network.
// Live networks read a mnemonic only from the environment of the single command that needs it
// (typed by the owner at runtime, never stored in a file — no .env, see CLAUDE.md). Prefer
// `pnpm --filter @hermes/solid lifecycle`, which prompts for the key instead.
export default defineConfig({
  paths: {
    contracts: 'contracts',
    artifacts: 'artifacts',
    tests: 'test',
  },
  compiler: { evmCompat: true },
  networks: {
    mock: { type: 'mock' },
    chipnet: { type: 'electrum', network: 'chipnet', mnemonic: process.env.SOLIDCASH_MNEMONIC_CHIPNET },
    mainnet: { type: 'electrum', network: 'mainnet', mnemonic: process.env.SOLIDCASH_MNEMONIC_MAINNET },
  },
  defaultNetwork: 'mock',
});
