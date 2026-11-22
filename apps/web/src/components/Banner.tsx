import { useState } from 'react';
import { HERMES } from '@hermes/chain';

export interface BannerConfig {
  presentationUrl: string | null;
  presentationIsDraft: boolean;
  repoUrl: string | null;
  ember2026Address: string | null;
  preExisting: { repo: string; demo: string } | null;
}

/** Only http(s) links from config are rendered as links. */
const safeUrl = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\/\S+$/.test(u) ? u : null);

/**
 * Required BCH BLAZE banner: Widget Factory presentation, repository, and the CashTokens
 * address for EMBER2026 donations. Values come from config/hermes.json → web.banner and are
 * filled in by the owner at ship time; nothing here is invented. Missing values render as
 * clearly-marked placeholders.
 */
export function Banner({ config = HERMES.web.banner as BannerConfig }: { config?: BannerConfig }) {
  const b = config;
  const [copied, setCopied] = useState(false);
  const pres = safeUrl(b.presentationUrl);
  const repo = safeUrl(b.repoUrl);
  return (
    <div className="banner" role="region" aria-label="BCH BLAZE 2026 submission">
      <span className="banner-tag">BCH BLAZE 2026</span>
      {pres ? (
        <a href={pres} target="_blank" rel="noreferrer">
          Widget Factory presentation{b.presentationIsDraft && <span className="draft">draft</span>}
        </a>
      ) : null}
      {repo ? (
        <a href={repo} target="_blank" rel="noreferrer">
          Source code
        </a>
      ) : null}
      {b.ember2026Address ? (
        <span className="ember">
          <span>EMBER2026 (CashTokens):</span> <code>{b.ember2026Address}</code>
          <button
            className="link"
            onClick={() => {
              void navigator.clipboard?.writeText(b.ember2026Address!).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </span>
      ) : null}
      {b.preExisting && safeUrl(b.preExisting.repo) && (
        <span>
          Previous work: <a href={safeUrl(b.preExisting.repo)!}>repo</a>
          {safeUrl(b.preExisting.demo) && (
            <>
              {' '}
              · <a href={safeUrl(b.preExisting.demo)!}>demo</a>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * G40: thin, persistent strip shown on every tab while Pay is on BCH mainnet. One click goes back to chipnet
 * (no confirmation needed for the safe direction).
 */
export function MainnetStrip({ onChipnet }: { onChipnet: () => void }) {
  return (
    <div className="mainnet-strip" role="note" aria-label="Mainnet warning">
      <span className="mainnet-dot" aria-hidden="true" />
      <span>
        <b>Pay is on BCH mainnet</b> — payments move real funds.
      </span>
      <button className="link" onClick={onChipnet}>
        Switch Pay to chipnet
      </button>
    </div>
  );
}
