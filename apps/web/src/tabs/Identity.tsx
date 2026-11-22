import { useEffect, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  ChallengeVerifier,
  LocalBchSigner,
  LocalNostrSigner,
  Nip07Signer,
  identityNftStatus,
  nip39Claims,
  nip39ProfileTemplate,
  createBinding,
  npubOf,
  respondToChallenge,
  rotateBinding,
  verifyChain,
  type BchSigner,
  type Challenge,
  type NftStatus,
  type ResolvedIdentity,
} from '@hermes/id';
import { formatBch, type BchNetwork } from '@hermes/chain';
import { useHermes } from '../lib/context';
import {
  backupText,
  decodeBchWif,
  ensureLocalNostr,
  exportBchWif,
  getLocalNsec,
  localBchSigner,
  localWallet,
  nostrSigner,
  previousBchKeys,
  previousNsecs,
  setLocalBchKey,
  setLocalNsec,
} from '../lib/keys';
import { VerifyTool } from '../components/VerifyTool';
import { IdentityTools } from '../components/IdentityTools';
import { Qr } from '../components/Qr';
import { payLinkUrl } from '@hermes/pay';
import { WizardConnectBchSigner } from '../lib/wcsigner';
import { Card, Copy, NetBadge, Status, short } from '../components/ui';
import { load, loadChoice, save } from '../lib/storage';
import { changeLabel, nip39State, verifierEndpoint } from '../lib/identity-ui';

type BchMode = 'wizard' | 'local';
type Notice = { kind: 'ok' | 'warn' | 'err' | 'info'; text: string };

const when = (ts: number) => new Date(ts * 1000).toLocaleString();

export function Identity() {
  const { discovery, wc, provider, nostrMode, setNostrMode, idNetwork, setIdNetwork } = useHermes();
  const [npub, setNpub] = useState<string>();
  const [bchMode, setBchMode] = useState<BchMode>(loadChoice<BchMode>('hermes.bchMode', ['wizard', 'local'], 'local'));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [published, setPublished] = useState<{ event: Event; relays: { relay: string; ok: boolean }[] }>();
  const [current, setCurrent] = useState<ResolvedIdentity>();
  const [looked, setLooked] = useState(false);
  const [nsecInput, setNsecInput] = useState('');
  const [showNsec, setShowNsec] = useState(false);
  const [challengeLog, setChallengeLog] = useState<string[]>([]);
  const [verifierUrl, setVerifierUrl] = useState<string>(load<string>('hermes.verifierUrl', ''));
  const [balance, setBalance] = useState<bigint>();
  const [nft, setNft] = useState<NftStatus | { error: string }>();
  const [profile, setProfile] = useState<ReturnType<typeof nip39State> | { state: 'unknown'; text: string }>();
  const [confirm, setConfirm] = useState<'bch' | 'nostr'>();
  const [showWif, setShowWif] = useState(false);
  const [wifInput, setWifInput] = useState('');
  const [wifError, setWifError] = useState<string>();
  const [wifPending, setWifPending] = useState<{ key: Uint8Array }>();
  const [showPrev, setShowPrev] = useState(false);
  const [keysVersion, setKeysVersion] = useState(0);

  const signer = () => nostrSigner(nostrMode);
  const bchSigner = (): BchSigner => {
    if (bchMode === 'wizard') {
      if (wc.state !== 'connected' || !wc.manager) throw new Error('Connect a WizardConnect wallet first (top right).');
      return new WizardConnectBchSigner(wc.manager, provider(idNetwork), idNetwork);
    }
    return localBchSigner(idNetwork);
  };

  useEffect(() => {
    let live = true;
    signer()
      .getPublicKey()
      .then((pk) => {
        if (!live) return;
        setNpub(npubOf(pk));
        save('hermes.myNpub', npubOf(pk));
      })
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [nostrMode, keysVersion]);

  useEffect(() => {
    if (bchMode !== 'local') return;
    let live = true;
    setBalance(undefined);
    void provider(idNetwork)
      .getUtxos(localWallet(idNetwork).address)
      .then((u) => live && setBalance(u.reduce((n, x) => n + x.satoshis, 0n)))
      .catch(() => live && setBalance(-1n));
    return () => {
      live = false;
    };
  }, [bchMode, idNetwork, published, keysVersion]);

  async function refresh(who = npub) {
    if (!who) return;
    setBusy('Looking up your current binding…');
    try {
      const r = await discovery.resolve(who);
      setCurrent(r.identity);
      if (!r.identity && r.answered === 0) setError(`${r.error} — check the relays in Settings.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLooked(true);
      setBusy(undefined);
    }
  }

  useEffect(() => {
    setCurrent(undefined);
    setLooked(false);
    if (npub) void refresh(npub);
  }, [npub]);

  // F3: identity NFT pin — checked at the token address of every version (after a BCH rotation the
  // NFT stays at the old key until `hermes id nft-sync` moves it).
  useEffect(() => {
    setNft(undefined);
    if (!current?.current.payload?.idCategory) return;
    let live = true;
    const net = current.current.network ?? idNetwork;
    const addrs = [...new Set(current.chain.map((b) => b.tokenAddr))];
    void Promise.all(addrs.map(async (a) => (await provider(net).getUtxos(a)).map((u) => ({ address: a, token: u.token ? { category: u.token.category, nft: u.token.nft } : null }))))
      .then((lists) => live && setNft(identityNftStatus(current.chain, lists.flat())))
      .catch((e) => live && setNft({ error: `NFT lookup failed (Electrum unreachable: ${(e as Error).message})` }));
    return () => {
      live = false;
    };
  }, [current, idNetwork]);

  // F4: does the Nostr profile carry the NIP-39 claim for the current address?
  async function checkProfile(id = current) {
    if (!id) return setProfile(undefined);
    try {
      const { events, answered } = await discovery.query({ kinds: [0], authors: [id.current.nostr], limit: 5 });
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      setProfile(answered === 0 ? { state: 'unknown', text: 'No relay answered the profile lookup.' } : nip39State(nip39Claims(latest), id.current));
    } catch {
      setProfile({ state: 'unknown', text: 'Profile lookup failed.' });
    }
  }
  useEffect(() => {
    setProfile(undefined);
    void checkProfile(current);
  }, [current]);

  async function addToProfile() {
    if (!current) return;
    setError(undefined);
    setNotice(undefined);
    setBusy('Updating your Nostr profile…');
    try {
      const { events } = await discovery.query({ kinds: [0], authors: [current.current.nostr], limit: 5 });
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const ev = await signer().signEvent(nip39ProfileTemplate(latest, current.current));
      const r = await discovery.publish(ev);
      const ok = r.filter((x) => x.ok).length;
      if (!ok) throw new Error('No relay accepted the profile update');
      setNotice({
        kind: 'ok',
        text: `Profile updated on ${ok}/${r.length} relays: i = ${current.current.addr}. ${latest ? 'Your name, picture and other tags were kept.' : 'You had no profile yet; an empty one was created.'}`,
      });
      await new Promise((res) => setTimeout(res, 800));
      await checkProfile();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function publish(event: Event) {
    const relays = await discovery.publish(event);
    setPublished({ event, relays });
    if (!relays.some((r) => r.ok)) throw new Error('No relay accepted the event');
    await new Promise((r) => setTimeout(r, 1200));
  }

  // F1: Nostr key rotation — the old Nostr key approves, the BCH key signs again, a fresh browser key takes over.
  async function rotateNostr() {
    if (!current) return;
    setConfirm(undefined);
    setError(undefined);
    setNotice(undefined);
    setBusy('Rotating Nostr key…');
    try {
      const oldNpub = npubOf(current.current.nostr);
      const fresh = generateSecretKey();
      const { event } = await rotateBinding({
        prevEvent: current.current.event,
        currentBch: bchSigner(),
        currentNostr: signer(),
        newNostr: new LocalNostrSigner(fresh),
        network: idNetwork,
      });
      if (!verifyChain(event).ok) throw new Error('Self-check of the rotated binding failed');
      await publish(event);
      setLocalNsec(nip19.nsecEncode(fresh)); // the old browser key (if any) is kept under "previous keys"
      setNostrMode('local');
      const next = npubOf(event.pubkey);
      save('hermes.myNpub', next);
      setKeysVersion((v) => v + 1);
      setNpub(next);
      setNotice({
        kind: 'ok',
        text: `Nostr key rotated: v${current.current.seq} → v${current.current.seq + 1}. New npub ${short(next, 14, 6)} (a key in this browser — back it up below). Payers who still use your old npub ${short(oldNpub, 14, 6)} are sent to this new version.`,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function link() {
    setError(undefined);
    setNotice(undefined);
    setBusy('Signing with both keys…');
    try {
      const { event } = await createBinding({ bch: bchSigner(), nostr: signer(), network: idNetwork });
      const verdict = verifyChain(event);
      if (!verdict.ok) throw new Error(`Self-check failed: ${verdict.reasons.join(', ')}`);
      setBusy('Publishing to relays…');
      await publish(event);
      await refresh();
      setNotice({ kind: 'ok', text: 'Linked. Anyone can now resolve your npub to this BCH address and check both signatures.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  /** BCH key rotation to `nextKey` (fresh, or an imported WIF). The old key approves; the old key is kept aside. */
  async function rotateBch(nextKey: Uint8Array = generatePrivateKey()) {
    if (!current) return;
    setConfirm(undefined);
    setError(undefined);
    setNotice(undefined);
    setBusy('Rotating BCH key…');
    try {
      const oldAddr = current.current.addr;
      const { event } = await rotateBinding({
        prevEvent: current.current.event,
        currentBch: bchSigner(),
        currentNostr: signer(),
        newBch: new LocalBchSigner(nextKey),
        network: idNetwork,
      });
      if (!verifyChain(event).ok) throw new Error('Self-check of the rotated binding failed');
      await publish(event);
      setLocalBchKey(idNetwork, nextKey);
      setBchMode('local');
      save('hermes.bchMode', 'local');
      setKeysVersion((v) => v + 1);
      await refresh();
      const w = localWallet(idNetwork);
      setNotice({
        kind: 'ok',
        text: `BCH key rotated: v${current.current.seq} → v${current.current.seq + 1}. Payments now go to ${short(w.address, 18, 6)}. The old key (${short(oldAddr, 18, 6)}) is kept under "Previous keys" — sweep any coins left on it${current.current.payload?.idCategory ? ' and run nft-sync to move the identity NFT' : ''}.`,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function challengeDemo() {
    setError(undefined);
    const log: string[] = [];
    setChallengeLog(['…']);
    try {
      const api = verifierEndpoint(verifierUrl);
      if (api) {
        // F7: the same login against the verification HTTP API (apps/verifier).
        const ch = (await fetch(`${api}/challenge`, { method: 'POST' }).then((r) => r.json())) as Challenge;
        log.push(`Verifier API ${api} → challenge nonce ${ch.nonce.slice(0, 12)}…, audience ${ch.audience}`);
        const resp = await respondToChallenge(ch, bchSigner(), signer());
        log.push('You → signed the challenge with your BCH key and your Nostr key');
        const post = () =>
          fetch(`${api}/challenge/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response: resp }) }).then((r) => r.json());
        const r1 = (await post()) as { ok: boolean; reasons: string[] };
        log.push(r1.ok ? '✔ Verifier API: both signatures valid, keys match the current binding on relays — logged in' : `✘ Verifier API: ${r1.reasons.join(', ')}`);
        const r2 = (await post()) as { ok: boolean; reasons: string[] };
        log.push(r2.ok ? '✘ replay accepted (bug)' : `✔ Replay rejected by the API (${r2.reasons.join(', ')})`);
      } else {
        const verifier = new ChallengeVerifier(location.origin);
        const ch = verifier.issue();
        log.push(`Verifier (in this page) → challenge nonce ${ch.nonce.slice(0, 12)}…, audience ${ch.audience}`);
        const resp = await respondToChallenge(ch, bchSigner(), signer());
        log.push('You → signed the challenge with your BCH key and your Nostr key');
        const r1 = verifier.verify(resp, current?.current);
        log.push(r1.ok ? '✔ Verifier: both signatures valid, keys match the current binding — logged in' : `✘ ${r1.reasons.join(', ')}`);
        const r2 = verifier.verify(resp, current?.current);
        log.push(r2.ok ? '✘ replay accepted (bug)' : `✔ Replay of the same response rejected (${r2.reasons.join(', ')})`);
      }
    } catch (e) {
      log.push(`✘ ${(e as Error).message === 'Failed to fetch' ? 'Verifier API unreachable (is it running, and is the URL right?)' : (e as Error).message}`);
    }
    setChallengeLog(log);
  }

  function downloadBackup() {
    const text = backupText(idNetwork, { npub, addr: current?.current.addr, seq: current?.current.seq });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `hermes-id-backup-${idNetwork}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    save(`hermes.backedUp.${idNetwork}`, Math.floor(Date.now() / 1000));
    setKeysVersion((v) => v + 1);
  }

  async function startImport() {
    setWifError(undefined);
    try {
      const key = decodeBchWif(idNetwork, wifInput);
      const pk = binToHex(await new LocalBchSigner(key).getPublicKey());
      if (pk === binToHex(await localBchSigner(idNetwork).getPublicKey())) {
        setWifError('This key is already the browser key — nothing to import.');
        return;
      }
      if (localIsBound && bound!.bch !== pk) {
        // The browser key is the bound key: replacing it silently would leave the binding pointing elsewhere.
        setWifPending({ key });
        return;
      }
      setLocalBchKey(idNetwork, key);
      setWifInput('');
      setBchMode('local');
      save('hermes.bchMode', 'local');
      setKeysVersion((v) => v + 1);
      setNotice({
        kind: 'ok',
        text: bound?.bch === pk ? 'Restored: this browser now holds your bound BCH key again.' : `Imported. The browser BCH key is now ${short(localWallet(idNetwork).address, 18, 6)}; the previous one is kept under "Previous keys".`,
      });
    } catch (e) {
      setWifError((e as Error).message);
    }
  }

  const local = localWallet(idNetwork);
  const bound = current?.current;
  const localIsBound = !!bound && bchMode === 'local' && bound.addr === local.address;
  const prevBch = previousBchKeys(idNetwork);
  const prevNostr = previousNsecs();
  const backedUp = load<number>(`hermes.backedUp.${idNetwork}`, 0);
  void keysVersion;

  return (
    <div className="stack">
      <div className="hero small">
        <h2>Hermes ID</h2>
        <p>Bind a Bitcoin Cash key to your Nostr identity. Both keys sign the same canonical statement; anyone can verify it from relays.</p>
      </div>

      <div className="grid2">
        <Card title="1 · Nostr key">
          <div className="seg">
            <button className={nostrMode === 'nip07' ? 'on' : ''} onClick={() => setNostrMode('nip07')} disabled={!Nip07Signer.available()} title={Nip07Signer.available() ? '' : 'No NIP-07 extension (Alby, nos2x…) detected'}>
              Extension (NIP-07)
            </button>
            <button className={nostrMode === 'local' ? 'on' : ''} onClick={() => setNostrMode('local')}>
              Key in this browser
            </button>
          </div>
          {npub ? (
            <div className="kv">
              <span>npub</span>
              <code className="mono">{short(npub, 16, 8)}</code> <Copy text={npub} />
            </div>
          ) : (
            <p className="muted small">Loading your Nostr key…</p>
          )}
          {nostrMode === 'local' && (
            <details>
              <summary>Import or back up this key</summary>
              <div className="row">
                <input className="grow" placeholder="nsec1…" value={nsecInput} onChange={(e) => setNsecInput(e.target.value)} />
                <button
                  disabled={!nsecInput}
                  onClick={() => {
                    try {
                      setLocalNsec(nsecInput);
                      ensureLocalNostr();
                      setNsecInput('');
                      setKeysVersion((v) => v + 1);
                      setNotice({ kind: 'ok', text: 'Nostr key imported. The previous browser key is kept under "Previous keys".' });
                    } catch (e) {
                      setError(`Nostr key import: ${(e as Error).message}`);
                    }
                  }}
                >
                  Import
                </button>
              </div>
              {bound && <p className="muted small">Importing a different nsec switches this page to that identity; your current one stays on relays.</p>}
              <button className="link" onClick={() => setShowNsec((s) => !s)}>
                {showNsec ? 'Hide' : 'Show'} secret key
              </button>
              {showNsec && (
                <>
                  <code className="mono secret">{getLocalNsec()}</code> <Copy text={getLocalNsec() ?? ''} />
                </>
              )}
            </details>
          )}
        </Card>

        <Card title="2 · Bitcoin Cash key" aside={<NetBadge network={idNetwork} />}>
          <div className="seg">
            <button className={idNetwork === 'mainnet' ? 'on' : ''} onClick={() => setIdNetwork('mainnet')}>
              Mainnet
            </button>
            <button className={idNetwork === 'chipnet' ? 'on' : ''} onClick={() => setIdNetwork('chipnet')}>
              Chipnet
            </button>
          </div>
          <div className="seg">
            <button
              className={bchMode === 'wizard' ? 'on' : ''}
              onClick={() => {
                setBchMode('wizard');
                save('hermes.bchMode', 'wizard');
              }}
            >
              My wallet (WizardConnect)
            </button>
            <button
              className={bchMode === 'local' ? 'on' : ''}
              onClick={() => {
                setBchMode('local');
                save('hermes.bchMode', 'local');
              }}
            >
              Browser key
            </button>
          </div>
          {bchMode === 'wizard' ? (
            <p className="muted small">
              Your wallet signs a proof transaction that is <b>never broadcast</b> (WizardConnect signs transactions, not messages). Its first
              address needs any small coin. Payments to you then land in your own wallet.
              {wc.state !== 'connected' && <b> Not connected yet — use “Connect wallet” at the top right.</b>}
            </p>
          ) : (
            <p className="muted small">
              Address <code className="mono">{short(local.address, 18, 6)}</code> <Copy text={local.address} /> · balance{' '}
              {balance === undefined ? '…' : balance < 0n ? 'unavailable (Electrum unreachable)' : `${formatBch(balance)} BCH`}. Payments to you land on this browser key —
              use it as a receiving address and sweep it to your wallet. {!backedUp && <b>Not backed up yet (see “Back up” below).</b>}
            </p>
          )}
        </Card>
      </div>

      <Card title="3 · Link and publish">
        {!bound && looked && !busy && <p className="muted small">No Hermes ID binding found for this npub yet. One click signs with both keys and publishes to {discovery.relays.length} relays.</p>}
        <button className="primary" onClick={() => void link()} disabled={!!busy || !npub}>
          {bound ? 'Re-issue binding' : 'Link my BCH key to my Nostr identity'}
        </button>
        {bound && !localIsBound && bchMode === 'local' && (
          <Status kind="warn">
            Your binding points at {short(bound.addr, 18, 6)}, not this browser key ({short(local.address, 18, 6)}). Rotate the BCH key (below) or import the bound key’s WIF to sign
            for it.
          </Status>
        )}
        {busy && <Status kind="info">{busy}</Status>}
        {error && <Status kind="err">{error}</Status>}
        {notice && <Status kind={notice.kind}>{notice.text}</Status>}
        {published && (
          <div className="small">
            Event <code className="mono">{short(published.event.id)}</code> ·{' '}
            {published.relays.map((r) => (
              <span key={r.relay} className={r.ok ? 'ok' : 'err'}>
                {r.relay.replace('wss://', '')} {r.ok ? '✔' : '✘'}{' '}
              </span>
            ))}
          </div>
        )}
      </Card>

      {bound && current && (
        <Card title="Your current binding" aside={<span className="pill pill-ok">v{bound.seq}</span>}>
          <div className="kv">
            <span>npub</span>
            <code className="mono">{short(npubOf(bound.nostr), 16, 8)}</code>
          </div>
          <div className="kv">
            <span>BCH address</span>
            <code className="mono">{bound.addr}</code>
          </div>
          <div className="kv">
            <span>Token address</span>
            <code className="mono">{bound.tokenAddr}</code>
          </div>
          <div className="kv">
            <span>Version</span>
            <span>
              v{bound.seq} · since {when(bound.ts)} · first linked {when(current.firstSeen)} · {current.chain.length - 1} rotation(s)
            </span>
          </div>
          <div className="kv">
            <span>Identity NFT</span>
            <span className="small">
              {!bound.payload?.idCategory ? (
                <>
                  none — versions are pinned by relays only. Mint one (needs a funded key, run locally):{' '}
                  <code className="mono">pnpm --filter cli hermes id nft-mint --network {idNetwork}</code>
                </>
              ) : !nft ? (
                'checking…'
              ) : 'error' in nft ? (
                nft.error
              ) : (
                <>
                  <span className={`pill ${nft.state === 'synced' ? 'pill-ok' : 'pill-warn'}`}>{nft.pinned !== undefined ? `pins v${nft.pinned}` : nft.state}</span> {nft.message}{' '}
                  <code className="mono">{short(nft.category ?? '', 10, 6)}</code>
                  {nft.needsSync && (
                    <>
                      {' '}
                      Fix: <code className="mono">pnpm --filter cli hermes id nft-sync --network {idNetwork} --npub {npubOf(bound.nostr)}</code>
                    </>
                  )}
                </>
              )}
            </span>
          </div>
          <div className="kv">
            <span>Nostr profile</span>
            <span className="small">
              {profile ? (
                <>
                  <span className={`pill ${profile.state === 'current' ? 'pill-ok' : 'pill-warn'}`}>{profile.state === 'current' ? 'NIP-39 ✔' : profile.state === 'stale' ? 'outdated' : profile.state === 'none' ? 'not linked' : '?'}</span> {profile.text}
                </>
              ) : (
                'checking…'
              )}
            </span>
          </div>
          {current.warnings.map((w) => (
            <Status key={w.message} kind="warn">
              {w.message}
            </Status>
          ))}
          <div className="row wrap">
            <button onClick={() => setConfirm('bch')} disabled={!!busy}>
              Rotate BCH key
            </button>
            <button onClick={() => setConfirm('nostr')} disabled={!!busy}>
              Rotate Nostr key
            </button>
            <button onClick={() => void addToProfile()} disabled={!!busy || profile?.state === 'current'} title="Adds an i-tag with your BCH address to your kind-0 profile">
              {profile?.state === 'stale' ? 'Update my Nostr profile (NIP-39)' : profile?.state === 'current' ? 'On my Nostr profile ✔' : 'Show on my Nostr profile (NIP-39)'}
            </button>
            <button onClick={() => void challengeDemo()} disabled={!!busy}>
              Prove it’s me (challenge-response)
            </button>
            <a className="button ghost" href={`#pay?to=${npubOf(bound.nostr)}`}>
              Pay this identity →
            </a>
          </div>
          {confirm && (
            <Status kind="warn">
              {confirm === 'bch' ? (
                <>
                  <b>Rotate the BCH key?</b> A new key is created in this browser; your current BCH key ({short(bound.addr, 18, 6)}) and your Nostr key both sign v{bound.seq + 1}. Payers
                  are sent to the new address from now on. The old key is kept under “Previous keys” so you can sweep it.
                </>
              ) : (
                <>
                  <b>Rotate the Nostr key?</b> A new Nostr key is created in this browser; your current Nostr key approves the change and your BCH key signs v{bound.seq + 1}. Your old npub keeps
                  resolving to the new version{nostrMode === 'nip07' ? '; your extension key stays in the extension, the new key lives here — back it up' : '; the old nsec is kept under “Previous keys”'}.
                </>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => void (confirm === 'bch' ? rotateBch() : rotateNostr())}>
                  Confirm rotation
                </button>
                <button onClick={() => setConfirm(undefined)}>Cancel</button>
              </div>
            </Status>
          )}
          <details>
            <summary>Version history ({current.chain.length})</summary>
            <ol className="log">
              {current.chain.map((b, i) => (
                <li key={b.payloadHash}>
                  v{b.seq} · {when(b.ts)} · {changeLabel(current.chain[i - 1], b)} · npub <code className="mono">{short(npubOf(b.nostr), 12, 6)}</code> · <code className="mono">{short(b.addr, 18, 6)}</code>
                </li>
              ))}
            </ol>
          </details>
          <details>
            <summary>Challenge-response against the verification API (optional)</summary>
            <p className="muted small">
              Leave empty to run the verifier inside this page. To try the HTTP API, start it locally with <code className="mono">pnpm --filter verifier start -- --relays {discovery.relays.join(',')}</code> and
              enter its URL.
            </p>
            <input
              className="grow"
              placeholder="http://localhost:8787"
              value={verifierUrl}
              onChange={(e) => {
                setVerifierUrl(e.target.value);
                save('hermes.verifierUrl', e.target.value.trim());
              }}
            />
          </details>
          {challengeLog.length > 0 && (
            <ol className="log">
              {challengeLog.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ol>
          )}
          {npub && (
            <details>
              <summary>Share your pay link</summary>
              <div className="row wrap">
                <Qr value={payLinkUrl(location.origin, { to: npub })} />
                <div className="grow">
                  <code className="mono">{payLinkUrl(location.origin, { to: npub })}</code> <Copy text={payLinkUrl(location.origin, { to: npub })} />
                  <p className="muted small">Anyone who opens it sees your verified card and can pay you. Add &amp;amount=…&amp;memo=… for invoices.</p>
                </div>
              </div>
            </details>
          )}
          <details>
            <summary>Raw event (what relays store) — paste it into “Verify any binding”</summary>
            <Copy text={JSON.stringify(bound.event)} />
            <pre className="mono pre">{JSON.stringify(bound.event, null, 2)}</pre>
          </details>
        </Card>
      )}

      {bound && current && <IdentityTools identity={current} discovery={discovery} />}

      <Card title="Back up your keys · key loss">
        {bchMode === 'local' ? (
          <>
            <p className="muted small">
              The BCH key {nostrMode === 'local' ? 'and the Nostr key live' : 'lives'} only in this browser. Clearing site data loses {nostrMode === 'local' ? 'them' : 'it'}.{' '}
              {backedUp ? `Last backup downloaded ${when(backedUp)}.` : <b>No backup downloaded yet.</b>}
            </p>
            <div className="row wrap">
              <button className="primary" onClick={downloadBackup}>
                Download backup file
              </button>
              <button className="link" onClick={() => setShowWif((x) => !x)}>
                {showWif ? 'Hide' : 'Show'} BCH key (WIF)
              </button>
            </div>
            {showWif && (
              <div>
                <code className="mono secret">{exportBchWif(idNetwork)}</code> <Copy text={exportBchWif(idNetwork)} />
              </div>
            )}
            <div className="row">
              <input className="grow" placeholder={`Import a ${idNetwork} WIF (${idNetwork === 'mainnet' ? 'K… / L…' : 'c…'})`} value={wifInput} onChange={(e) => setWifInput(e.target.value)} />
              <button onClick={() => void startImport()} disabled={!wifInput || !!busy}>
                Import
              </button>
            </div>
            {wifError && <Status kind="err">{wifError}</Status>}
            {wifPending && (
              <Status kind="warn">
                <b>This browser key is your bound key.</b> Importing a different key without rotating would leave payers paying {short(bound?.addr ?? '', 18, 6)} while this page signs with
                another key.
                <div className="row wrap" style={{ marginTop: 8 }}>
                  <button
                    className="primary"
                    onClick={() => {
                      const k = wifPending.key;
                      setWifPending(undefined);
                      setWifInput('');
                      void rotateBch(k);
                    }}
                  >
                    Import and rotate my binding to it
                  </button>
                  <button
                    onClick={() => {
                      setLocalBchKey(idNetwork, wifPending.key);
                      setWifPending(undefined);
                      setWifInput('');
                      setKeysVersion((v) => v + 1);
                      setNotice({ kind: 'warn', text: 'Imported without rotating: your binding still names the old key (kept under “Previous keys”).' });
                    }}
                  >
                    Replace only
                  </button>
                  <button onClick={() => setWifPending(undefined)}>Cancel</button>
                </div>
              </Status>
            )}
          </>
        ) : (
          <p className="muted small">Your BCH key is in your own wallet (WizardConnect) — back it up there (seed phrase).</p>
        )}
        {(prevBch.length > 0 || prevNostr.length > 0) && (
          <details open={showPrev} onToggle={(e) => setShowPrev((e.target as HTMLDetailsElement).open)}>
            <summary>
              Previous keys ({prevBch.length} BCH, {prevNostr.length} Nostr) — replaced by rotations or imports
            </summary>
            <ul className="log">
              {prevBch.map((p) => (
                <li key={p.wif}>
                  BCH <code className="mono">{short(p.address, 18, 6)}</code> <Copy text={p.address} /> · WIF <Copy text={p.wif} /> · {when(p.ts)} — sweep any coins (and the identity NFT) left here
                </li>
              ))}
              {prevNostr.map((p) => (
                <li key={p.nsec}>
                  Nostr <code className="mono">{short(p.npub, 12, 6)}</code> · nsec <Copy text={p.nsec} /> · {when(p.ts)}
                </li>
              ))}
            </ul>
          </details>
        )}
        <ul className="log small">
          <li>
            <b>Lost the BCH key</b> (Nostr key still here): restore the Nostr key, then “Rotate BCH key” — your Nostr key approves the new BCH key.
          </li>
          <li>
            <b>Lost the Nostr key</b> (BCH key still here): restore the BCH key (WIF), then “Rotate Nostr key” — your BCH key approves the new Nostr key.
          </li>
          <li>
            <b>Lost both</b>: the identity cannot be recovered or extended. Link a new one and tell your contacts; the old binding keeps resolving to its last address, so empty that
            address if you can.
          </li>
          <li>
            <b>Key stolen</b>: rotate it right away with the other key; payers are sent to the new version within one relay round-trip.
          </li>
        </ul>
      </Card>

      <VerifyTool mine={bound?.event} />

      <p className="muted small">
        Discovery uses {discovery.relays.length} relays ({discovery.relays.map((r) => r.replace('wss://', '')).join(', ')}) — change them in Settings. Kind 30078, tag d=hermes-id;
        searchable by address with tag i=bch:&lt;address&gt;.
      </p>
    </div>
  );
}

export type { BchNetwork };
