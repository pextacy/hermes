import { useState } from 'react';
import evmSource from '../../../../../packages/evm-htlc/src/HermesHTLC.sol?raw';
import cashSource from '../../../../../packages/swap/contracts/HermesHtlc.cash?raw';
import solidSource from '../../../../../packages/solid/contracts/HermesHtlc.scash?raw';
import ledgerSource from '../../../../../packages/solid/contracts/HermesSwapLedger.scash?raw';
import shardSource from '../../../../../packages/drops/contracts/DropsShard.cash?raw';
import vaultSource from '../../../../../packages/drops/contracts/DropsVault.cash?raw';
import pendingSource from '../../../../../packages/drops/contracts/DropsPending.cash?raw';
import htlcTemplate from '../../../../../packages/xo/templates/hermes-htlc.json';
import { Card } from '../ui';
import { CopyButton, downloadText } from './shared';

export interface ContractFile {
  path: string;
  lang: string;
  about: string;
  source: string;
}

export const CONTRACTS: ContractFile[] = [
  { path: 'packages/evm-htlc/src/HermesHTLC.sol', lang: 'Solidity (EVM)', about: 'USDC side of the swap', source: evmSource },
  { path: 'packages/swap/contracts/HermesHtlc.cash', lang: 'CashScript', about: 'PUSD / BCH side of the swap', source: cashSource },
  { path: 'packages/solid/contracts/HermesHtlc.scash', lang: 'SolidCash', about: 'the same HTLC in the Solidity dialect for BCH', source: solidSource },
  { path: 'packages/solid/contracts/HermesSwapLedger.scash', lang: 'SolidCash', about: 'stateful ledger of settled swaps', source: ledgerSource },
  { path: 'packages/drops/contracts/DropsShard.cash', lang: 'CashScript', about: 'Merkle claim shard (leaf + proof check)', source: shardSource },
  { path: 'packages/drops/contracts/DropsVault.cash', lang: 'CashScript', about: 'Drops vault holding the reward tokens', source: vaultSource },
  { path: 'packages/drops/contracts/DropsPending.cash', lang: 'CashScript', about: 'timelocked pending root (authority veto window)', source: pendingSource },
  {
    path: 'packages/xo/templates/hermes-htlc.json#htlcRedeemBytecode',
    lang: 'XO / CashAssembly',
    about: 'the HTLC as an XO template script',
    source: (htlcTemplate as { scripts: Record<string, string> }).scripts.htlcRedeemBytecode,
  },
];

const fileName = (p: string) => (p.includes('#') ? p.split('#')[1] + '.casm' : p.split('/').pop()!);

/** G30 — contract source viewer with copy and download. */
export function ContractSources() {
  const [sel, setSel] = useState(0);
  const c = CONTRACTS[sel];
  const lines = c.source.split('\n');
  return (
    <Card title="Contract sources">
      <p className="small muted">One HTLC in four languages, plus the Drops covenants — the exact files the build compiles, bundled into this page.</p>
      <div className="dev-files" role="tablist" aria-label="contract files">
        {CONTRACTS.map((f, i) => (
          <button key={f.path} role="tab" aria-selected={i === sel} className={i === sel ? 'on' : ''} onClick={() => setSel(i)}>
            <span>{fileName(f.path)}</span>
            <span className="small muted">{f.lang}</span>
          </button>
        ))}
      </div>
      <div className="dev-file-head">
        <div>
          <code className="small">{c.path}</code>
          <div className="small muted">
            {c.about} · {lines.length} lines · {new TextEncoder().encode(c.source).length.toLocaleString()} bytes
          </div>
        </div>
        <div className="row">
          <CopyButton text={c.source} />
          <button className="small" onClick={() => downloadText(fileName(c.path), c.source)}>
            Download
          </button>
        </div>
      </div>
      <pre className="mono pre dev-source" aria-label={`source of ${c.path}`}>
        {lines.map((l, i) => (
          <div key={i}>
            <span className="dev-ln">{i + 1}</span>
            {l || ' '}
          </div>
        ))}
      </pre>
    </Card>
  );
}
