import { useEffect, useState } from 'react';
import { load, save } from '../lib/storage';

/** The 2-minute path for judges, visible on every tab; each step ticks off once its tab was opened. */
const STEPS = [
  { tab: 'pay', title: 'Pay a person', hint: 'Click “Create my Hermes ID in one click”, then look at the verified card.' },
  { tab: 'swap', title: 'Swap USDC ⇄ PUSD', hint: 'Click “Run the swap”, then try “Malicious solver”.' },
  { tab: 'claims', title: 'Claim rewards', hint: 'In the sandbox: publish a root, wait out the timelock, claim, then claim again.' },
  { tab: 'identity', title: 'Rotate & verify', hint: 'Link your keys, rotate one, then verify a tampered binding.' },
  { tab: 'developers', title: 'Under the hood', hint: 'Open any tool: XO templates, SolidCash contracts, the verifier.' },
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
          Show the tour ({seen.length}/{STEPS.length})
        </button>
      </div>
    );
  return (
    <div className="tour" role="navigation" aria-label="2-minute tour">
      <div className="tour-head">
        <b title="Nothing in the tour needs a wallet or funds">Tour</b>
      <ol className="tour-steps">
        {STEPS.map((s, i) => (
          <li key={s.tab} className={`${s.tab === tab ? 'on' : ''} ${seen.includes(s.tab) ? 'seen' : ''}`}>
            <a href={`#${s.tab}`}>
              <span className="tour-n">{seen.includes(s.tab) && s.tab !== tab ? '✓' : i + 1}</span> {s.title}
            </a>
          </li>
        ))}
      </ol>
        <button className="link small" onClick={() => (setHidden(true), save('hermes.tourHidden', true))} aria-label="Hide the tour">
          Hide
        </button>
      </div>
      {current && <p className="small tour-hint">{current.hint}</p>}
    </div>
  );
}
