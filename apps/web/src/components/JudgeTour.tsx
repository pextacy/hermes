import { useEffect, useState } from 'react';
import { load, save } from '../lib/storage';

/** The 2-minute path for judges, visible on every tab; each step ticks off once its tab was opened. */
const STEPS = [
  { tab: 'pay', title: 'Pay a person', hint: '“Create my Hermes ID in one click” → a card verified with both keys, resolved from relays.' },
  { tab: 'swap', title: 'Swap USDC ⇄ PUSD', hint: '“Run the swap”: the real HTLC contracts on both chains, in your browser — attacks get blocked.' },
  { tab: 'claims', title: 'Claim rewards', hint: 'Sandbox: publish → timelock → claim → claim again (“already claimed”) → next epoch pays the difference.' },
  { tab: 'identity', title: 'Rotate & verify', hint: 'Link, rotate a key, and paste a tampered binding into “Verify any binding”.' },
  { tab: 'developers', title: 'Under the hood', hint: 'XO templates + invitation viewer, SolidCash lifecycle and ledger, verification library.' },
] as const;

export function JudgeTour({ tab }: { tab: string }) {
  const [hidden, setHidden] = useState(() => load<boolean>('hermes.tourHidden', false));
  const [seen, setSeen] = useState<string[]>(() => load<string[]>('hermes.tourSeen', []));
  useEffect(() => {
    if (STEPS.some((s) => s.tab === tab) && !seen.includes(tab)) {
      const next = [...seen, tab];
      setSeen(next);
      save('hermes.tourSeen', next);
    }
  }, [tab]);
  const current = STEPS.find((s) => s.tab === tab);
  if (hidden)
    return (
      <div className="tour tour-min">
        <button className="link small" onClick={() => (setHidden(false), save('hermes.tourHidden', false))}>
          Show the 2-minute tour ({seen.length}/{STEPS.length})
        </button>
      </div>
    );
  return (
    <div className="tour" role="navigation" aria-label="2-minute tour">
      <div className="tour-head">
        <b>2-minute tour</b>
        <span className="muted small">
          {seen.length}/{STEPS.length} seen · nothing here needs a wallet or funds
        </span>
        <button className="link small" onClick={() => (setHidden(true), save('hermes.tourHidden', true))} aria-label="Hide the tour">
          hide
        </button>
      </div>
      <ol className="tour-steps">
        {STEPS.map((s, i) => (
          <li key={s.tab} className={`${s.tab === tab ? 'on' : ''} ${seen.includes(s.tab) ? 'seen' : ''}`}>
            <a href={`#${s.tab}`}>
              <span className="tour-n">{seen.includes(s.tab) && s.tab !== tab ? '✓' : i + 1}</span> {s.title}
            </a>
          </li>
        ))}
      </ol>
      {current && <p className="small tour-hint">{current.hint}</p>}
    </div>
  );
}
