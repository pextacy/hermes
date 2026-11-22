import htlcTemplate from '../../../../packages/xo/templates/hermes-htlc.json';
import identityTemplate from '../../../../packages/xo/templates/hermes-identity.json';
import dropsClaimTemplate from '../../../../packages/xo/templates/hermes-drops-claim.json';
import { InvitationViewer } from '../components/InvitationViewer';
import { SolidLifecycle } from '../components/SolidLifecycle';
import { useEffect } from 'react';
import { Card } from '../components/ui';
import { useHashParams } from '../lib/context';
import { VerifierPlayground } from '../components/dev/VerifierPlayground';
import { ContractSources } from '../components/dev/ContractSources';
import { TestReport } from '../components/dev/TestReport';
import { PayloadExplorer } from '../components/dev/PayloadExplorer';
import { HashlockTool } from '../components/dev/HashlockTool';
import { NostrKinds } from '../components/dev/NostrKinds';
import { LeafEncoder } from '../components/dev/LeafEncoder';

/** Developer tools (Round 3, G29–G35); each section has id `dev-<key>`. */
const TOOLS = [
  { key: 'verifier', label: 'Verifier API', el: <VerifierPlayground /> },
  { key: 'payload', label: 'Canonical payload', el: <PayloadExplorer /> },
  { key: 'hashlock', label: 'Hashlock', el: <HashlockTool /> },
  { key: 'leaf', label: 'Drops leaf', el: <LeafEncoder /> },
  { key: 'kinds', label: 'Nostr kinds', el: <NostrKinds /> },
  { key: 'sources', label: 'Contract sources', el: <ContractSources /> },
  { key: 'tests', label: 'Test report', el: <TestReport /> },
];

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

const goTo = (key: string, smooth = true) => document.getElementById(`dev-${key}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });

export function Developers() {
  // G42: #developers?tool=<key> opens on that tool, and the jump buttons keep the link shareable.
  const { params, setParams } = useHashParams();
  useEffect(() => {
    if (params.tool && TOOLS.some((t) => t.key === params.tool)) setTimeout(() => goTo(params.tool!, false), 50);
  }, []);
  return (
    <div className="stack">
      <div className="hero small">
        <h2>Developers</h2>
        <p>Everything Hermes uses is reusable: XO templates, one HTLC in four languages, SolidCash contracts you can run here, and a verification library.</p>
      </div>

      <nav className="dev-nav" aria-label="Developer tools">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            className="small"
            onClick={() => {
              setParams({ tool: t.key });
              goTo(t.key);
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {TOOLS.map((t) => (
        <div key={t.key} id={`dev-${t.key}`} className="dev-anchor">
          {t.el}
        </div>
      ))}

      <Card title="XO templates (Build With XO)">
        <ul>
          <li>
            <b>Hermes HTLC</b> — roles initiator / counterparty; starting actions <code>lock</code>, <code>lockTokens</code>; follow-ups{' '}
            <code>claim</code>, <code>claimTokens</code>, <code>refund</code>, <code>refundTokens</code> offered by the HTLC locking script.{' '}
            <button className="link" onClick={() => download('hermes-htlc.json', htlcTemplate)}>
              download JSON
            </button>
          </li>
          <li>
            <b>Hermes Identity NFT</b> — <code>mintIdentity</code>, follow-up <code>rotateIdentity</code>; commitment pins the binding version.{' '}
            <button className="link" onClick={() => download('hermes-identity.json', identityTemplate)}>
              download JSON
            </button>
          </li>
          <li>
            <b>Hermes Drops claim</b> — <code>claim</code> (first claim) and <code>claimAgain</code> (burns the old receipt); the covenant
            scripts are the compiled DropsShard/DropsVault contracts, byte-identical to the CashScript addresses (tested).{' '}
            <button className="link" onClick={() => download('hermes-drops-claim.json', dropsClaimTemplate)}>
              download JSON
            </button>{' '}
            · <a href="#claims?guide">Drops developer guide</a>
          </li>
        </ul>
        <p className="small">
          Party CLI (one wallet per party, mnemonic typed at runtime, invitations as files):{' '}
          <code>pnpm --filter @hermes/xo htlc secret|create|join|fund|claim|refund|inspect</code>. Import check against a local XO engine:{' '}
          <code>pnpm --filter @hermes/xo check</code>. Inspect invitations here (below) or in the XO debug tool:{' '}
          <a href="https://blaze.xo.cash/">blaze.xo.cash</a>. Party-by-party engine helpers: <code>packages/xo/src/flow.ts</code>.
        </p>
      </Card>

      <SolidLifecycle />

      <InvitationViewer />

      <Card title="Verify a binding yourself">
        <pre className="mono pre">{`import { Discovery, verifyChain } from '@hermes/id';

const d = new Discovery();                       // ≥ 3 public relays, no Hermes server
const { identity } = await d.resolve('npub1…'); // or name@domain, or a cashaddr
identity.current.addr;                           // verified destination
verifyChain(identity.current.event).ok;          // both signatures + rotation chain, offline`}</pre>
      </Card>

    </div>
  );
}
