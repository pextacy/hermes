/**
 * Hero illustrations: one per section, drawn with HTML/SVG in the app's own tokens. They depict what the
 * section does (labelled "Example" where they show sample data); nothing here is live.
 */

function Lock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
    </svg>
  );
}

function PayArt() {
  return (
    <div className="art art-pay" aria-hidden="true">
      <div className="art-card">
        <div className="art-row">
          <span className="art-avatar">A</span>
          <div className="art-who">
            <b>alice</b>
            <span className="mono">npub1q8n5…7hx2ka</span>
          </div>
          <span className="stamp">Verified</span>
        </div>
        <ul className="art-checks">
          <li>BCH key signed this Nostr key</li>
          <li>Nostr key signed this BCH key</li>
          <li>Version 2 · rotation chain verified</li>
        </ul>
        <div className="art-kv">
          <span>Pays to</span>
          <span className="mono">bitcoincash:qr7f…m4c9</span>
        </div>
        <div className="art-send">Send 0.05 BCH</div>
      </div>
      <span className="art-note">Example</span>
    </div>
  );
}

function SwapArt() {
  return (
    <div className="art art-swap" aria-hidden="true">
      <div className="art-chain">
        <span className="art-coin usdc">$</span>
        <span className="art-chain-main">
          <b>5.00 USDC</b>
          <span className="art-muted">Base</span>
        </span>
        <span className="art-lock">
          <Lock /> T₁ 3 h
        </span>
      </div>
      <div className="art-bridge">
        <span className="art-dot" />
        <span className="art-secret mono">sha256(secret)</span>
      </div>
      <div className="art-chain">
        <span className="art-coin pusd">₿</span>
        <span className="art-chain-main">
          <b>4.97 PUSD</b>
          <span className="art-muted">Bitcoin Cash</span>
        </span>
        <span className="art-lock">
          <Lock /> T₂ 1 h
        </span>
      </div>
      <span className="art-note">Example</span>
    </div>
  );
}

function ClaimsArt() {
  // A depth-3 tree; the proof path from leaf 5 to the root is highlighted.
  const x = (i: number, n: number) => ((i + 0.5) * 300) / n + 10;
  const levels = [1, 2, 4, 8];
  const path = [0, 1, 2, 5]; // index at each level
  return (
    <div className="art art-claims" aria-hidden="true">
      <svg viewBox="0 0 320 208">
        {levels.slice(1).map((n, li) =>
          Array.from({ length: n }, (_, i) => {
            const parent = Math.floor(i / 2);
            const on = path[li + 1] === i && path[li] === parent;
            return <line key={`${li}-${i}`} className={on ? 'on' : ''} x1={x(parent, levels[li])} y1={20 + li * 55} x2={x(i, n)} y2={20 + (li + 1) * 55} />;
          }),
        )}
        {levels.map((n, li) =>
          Array.from({ length: n }, (_, i) => (
            <circle key={`c${li}-${i}`} className={path[li] === i ? 'on' : ''} cx={x(i, n)} cy={20 + li * 55} r={li === 0 ? 9 : li === 3 ? 6 : 7} />
          )),
        )}
        <text x={x(0, 1) + 16} y={24}>
          root
        </text>
        <text x={x(5, 8)} y={204} textAnchor="middle" className="on">
          you
        </text>
      </svg>
      <div className="art-leafs">Your proof path to the on-chain root</div>
    </div>
  );
}

function IdentityArt() {
  return (
    <div className="art art-id" aria-hidden="true">
      <div className="art-keys">
        <span className="art-key">BCH key</span>
        <span className="art-key">Nostr key</span>
      </div>
      <svg className="art-arrows" viewBox="0 0 200 40">
        <path d="M50 0 C50 25, 100 15, 100 40 M150 0 C150 25, 100 15, 100 40" />
      </svg>
      <div className="art-doc">
        <div className="mono art-doc-lines">
          <span>hermes-id v1</span>
          <span>bch: bitcoincash:qr7f…</span>
          <span>nostr: npub1q8n5…</span>
          <span>version: 2</span>
        </div>
        <div className="art-sigs">
          <span>✓ BCH signature</span>
          <span>✓ Nostr signature</span>
        </div>
      </div>
    </div>
  );
}

function DevArt() {
  return (
    <div className="art art-dev" aria-hidden="true">
      <pre className="mono">
        <span className="c">{'// resolve and verify, no server'}</span>
        {'\n'}
        <span className="k">const</span> {'{ identity } = '}
        <span className="k">await</span> {'d.resolve('}
        <span className="s">{"'npub1…'"}</span>
        {');\n'}
        {'verifyChain(identity.current.event).ok'}
        {'\n'}
        <span className="c">{'// → true'}</span>
      </pre>
    </div>
  );
}

export function HeroArt({ kind }: { kind: 'pay' | 'swap' | 'claims' | 'identity' | 'developers' }) {
  return kind === 'pay' ? <PayArt /> : kind === 'swap' ? <SwapArt /> : kind === 'claims' ? <ClaimsArt /> : kind === 'identity' ? <IdentityArt /> : <DevArt />;
}
