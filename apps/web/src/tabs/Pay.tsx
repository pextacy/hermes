import { useEffect, useRef, useState } from 'react';
import {
  PAYMENT_NOTE_TAG,
  addToHistory,
  amountProblem,
  checkNip05,
  localNoteDecrypt,
  normalizeHistory,
  parsePayLink,
  payLinkUrl,
  paymentMemo,
  paymentNoteEvent,
  paymentNoteTemplate,
  paymentNoteText,
  readPaymentNotes,
  resolveRecipient,
  type Nip05Status,
  type PaidEntry,
  type PayLink,
  type PaymentNote,
  type ResolvedRecipient,
  buildReceipt,
  parseScanned,
  previewBuilder,
  type PaymentReceipt,
  type TxPreview,
} from '@hermes/pay';
import { createBinding, npubOf, parseRecipient, verifyChain } from '@hermes/id';
import * as nip19 from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { PLAIN_DUST_SATS, explorerTxUrl, formatBch, getConfiguredToken, getTokenMeta, parseUnits, buildPayment, type TokenMeta } from '@hermes/chain';
import { SignatureTemplate, type Utxo } from 'cashscript';
import { useHermes } from '../lib/context';
import { ensureLocalNostr, getLocalNsec, localBchSigner, localWallet } from '../lib/keys';
import { wcSendOutputs } from '../lib/wizard';
import { Card, NetBadge, Status, TxLink, short, Copy, More } from '../components/ui';
import { Qr } from '../components/Qr';
import { load, save } from '../lib/storage';
import { AddressGuardBox, BatchPay, ContactBadge, ContactsCard, QrScan, ReceiptButton, RequestWatcher, TxPreviewView, estimatePreview, isRawAddress, receiptLine } from '../components/PayExtras';
import { FeatureGrid, Section } from '../components/Sections';
import { HeroArt } from '../components/HeroArt';

type S = Utxo & { lockingBytecode: string };
/** BCH, a configured token (PUSD / FLDCH), or any fungible CashToken by category id. */
type AssetChoice = 'BCH' | 'PUSD' | 'FLDCH' | 'TOKEN';

interface Nip07Ext {
  getPublicKey(): Promise<string>;
  signEvent(e: unknown): Promise<never>;
  nip04?: { encrypt(pk: string, text: string): Promise<string>; decrypt(pk: string, ct: string): Promise<string> };
}
const nip07 = () => (globalThis as unknown as { nostr?: Nip07Ext }).nostr;

const HISTORY_KEY = 'hermes.payHistory';
const isCategory = (v: string) => /^[0-9a-f]{64}$/.test(v);
/** Where this app lives (keeps a static-hosting base path in shared links). */
const appBase = () => `${location.origin}${location.pathname}`;

const NIP05_TEXT: Record<Nip05Status, string> = {
  match: 'points to this key',
  mismatch: 'points to a DIFFERENT key — the name is not theirs',
  'not-found': 'is not registered on that domain',
  unreachable: 'could not be checked (domain unreachable) — not verified',
  invalid: 'is not a valid NIP-05 name',
};

export function Pay() {
  const { discovery, payNetwork, provider, wc, nostrMode } = useHermes();
  const [input, setInput] = useState('');
  const [resolvedInput, setResolvedInput] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [recipient, setRecipient] = useState<ResolvedRecipient>();
  const [error, setError] = useState<string>();
  const [asset, setAsset] = useState<AssetChoice>('BCH');
  const [tokenCategory, setTokenCategory] = useState('');
  const [customMeta, setCustomMeta] = useState<TokenMeta>();
  const [customMetaError, setCustomMetaError] = useState<string>();
  const [amount, setAmount] = useState('0.0001');
  const [memo, setMemo] = useState('');
  const [confirmMainnet, setConfirmMainnet] = useState(false);
  const [sending, setSending] = useState(false);
  const [txid, setTxid] = useState<string>();
  const [pusd, setPusd] = useState<TokenMeta>();
  const [fldch, setFldch] = useState<TokenMeta>();
  const [payer, setPayer] = useState<'wizard' | 'local'>('wizard');
  const [localBalance, setLocalBalance] = useState<bigint>();
  const myNpub = load<string | null>('hermes.myNpub', null);
  const [history, setHistory] = useState<PaidEntry[]>(() => normalizeHistory(load<unknown>(HISTORY_KEY, [])));
  const [nip05, setNip05] = useState<{ name: string; status?: Nip05Status; typed: boolean }[]>([]);
  const [notify, setNotify] = useState(false);
  const [noteStatus, setNoteStatus] = useState<{ kind: 'ok' | 'err' | 'info'; text: string }>();
  const topRef = useRef<HTMLDivElement>(null);
  // G6: the transaction is previewed (fee, size) before it can be sent; G5: receipt after.
  const [preview, setPreview] = useState<TxPreview>();
  const [receipt, setReceipt] = useState<PaymentReceipt>();
  useEffect(() => setPreview(undefined), [recipient, asset, amount, memo, payer, tokenCategory, customMeta]);

  // F8: pay links (#pay?to=…&amount=…&asset=…&memo=…) prefill and resolve — on load and
  // whenever the hash changes while the app is open (a link clicked in another tab of the app).
  useEffect(() => {
    const apply = () => {
      const link = parsePayLink(location.hash);
      if (link) applyLink(link);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  function applyLink(link: PayLink) {
    setInput(link.to);
    if (link.amount) setAmount(link.amount);
    if (link.asset === 'BCH' || link.asset === 'PUSD') setAsset(link.asset as 'BCH' | 'PUSD');
    else if (link.asset && isCategory(link.asset)) {
      setAsset('TOKEN');
      setTokenCategory(link.asset);
    }
    setMemo(link.memo ?? '');
    void resolveFor(link.to);
  }

  // F10: is the NIP-05 name (the one typed, and the one on the profile) really this key?
  useEffect(() => {
    const c = recipient?.card;
    if (!c) return setNip05([]);
    const typed = resolvedInput && parseRecipient(resolvedInput).kind === 'nip05' ? resolvedInput.trim().toLowerCase() : undefined;
    const names = [...new Set([typed, c.profile?.nip05?.trim().toLowerCase()].filter((n): n is string => !!n))];
    setNip05(names.map((name) => ({ name, typed: name === typed })));
    let live = true;
    for (const name of names) {
      void checkNip05(name, c.nostr).then((status) => live && setNip05((l) => l.map((x) => (x.name === name ? { ...x, status } : x))));
    }
    return () => {
      live = false;
    };
  }, [recipient]);

  useEffect(() => {
    void getConfiguredToken(payNetwork, 'PUSD').then(setPusd).catch(() => setPusd(undefined));
    void getConfiguredToken(payNetwork, 'FLDCH').then(setFldch).catch(() => setFldch(undefined));
  }, [payNetwork]);

  // Any other CashToken: decimals come from BCMR metadata, never guessed (invariant 6).
  useEffect(() => {
    setCustomMeta(undefined);
    setCustomMetaError(undefined);
    if (asset !== 'TOKEN' || !tokenCategory) return;
    if (!isCategory(tokenCategory)) return setCustomMetaError('A token category is 64 hex characters');
    let live = true;
    void getTokenMeta(tokenCategory)
      .then((m) => live && setCustomMeta(m))
      .catch(() => live && setCustomMetaError('No BCMR metadata found for this token, so Hermes can’t know its decimals. Not sending.'));
    return () => {
      live = false;
    };
  }, [asset, tokenCategory]);

  useEffect(() => {
    if (payer !== 'local') return;
    const w = localWallet(payNetwork);
    let live = true;
    setLocalBalance(undefined);
    void provider(payNetwork)
      .getUtxos(w.address)
      .then((u) => live && setLocalBalance(u.filter((x) => !x.token).reduce((n, x) => n + x.satoshis, 0n)))
      .catch(() => live && setLocalBalance(undefined));
    return () => {
      live = false;
    };
  }, [payer, payNetwork, txid]);

  const token: TokenMeta | undefined = asset === 'PUSD' ? pusd : asset === 'FLDCH' ? fldch : asset === 'TOKEN' ? customMeta : undefined;
  const assetLabel = asset === 'BCH' ? 'BCH' : (token?.symbol ?? (asset === 'TOKEN' ? 'tokens' : asset));
  const decimals = asset === 'BCH' ? 8 : token?.decimals;
  const amountError = decimals === undefined ? undefined : amountProblem(amount, decimals, asset === 'BCH' ? PLAIN_DUST_SATS : 0n);
  const assetError =
    asset === 'PUSD' && !pusd
      ? `PUSD is not configured for ${payNetwork} in this build.`
      : asset === 'FLDCH' && !fldch
        ? `FLDCH is not configured for ${payNetwork}.`
        : asset === 'TOKEN'
          ? !tokenCategory
            ? 'Paste the token category id.'
            : customMetaError ?? (!customMeta ? 'Looking up token metadata…' : undefined)
          : undefined;

  function remember(id: string, noted: boolean) {
    if (!recipient) return;
    const e: PaidEntry = {
      at: Date.now(),
      to: recipient.card.npub,
      name: recipient.card.profile?.name,
      amount,
      asset: assetLabel,
      txid: id,
      network: payNetwork,
      memo: paymentMemo(memo),
      note: noted || undefined,
    };
    setHistory((h) => {
      const next = addToHistory(h, e);
      save(HISTORY_KEY, next);
      return next;
    });
  }

  // F11: optional encrypted note to the recipient (NIP-04 DM). Signed by the NIP-07 extension
  // when that is the chosen Nostr signer (so the recipient sees who paid), else the browser key.
  async function sendNote(id: string) {
    if (!notify || !recipient) return;
    setNoteStatus({ kind: 'info', text: 'Sending encrypted note…' });
    try {
      const to = recipient.card.nostr;
      const fields = { recipientPubkey: to, amount, asset: assetLabel, txid: id, memo: paymentMemo(memo) };
      const ext = nip07();
      let ev;
      if (nostrMode === 'nip07' && ext?.nip04) {
        ev = await ext.signEvent(paymentNoteEvent(to, await ext.nip04.encrypt(to, paymentNoteText(fields))));
      } else {
        const signer = ensureLocalNostr();
        ev = await signer.signEvent(await paymentNoteTemplate({ ...fields, senderSecret: signer.secretKey }));
      }
      const r = await discovery.publish(ev);
      const ok = r.filter((x) => x.ok).length;
      setNoteStatus(
        ok > 0
          ? { kind: 'ok', text: `Encrypted note delivered to ${ok}/${r.length} relays. ${recipient.card.profile?.name ?? 'They'} can read it under “Payment notes for you”.` }
          : { kind: 'err', text: 'Note not sent: no relay accepted it.' },
      );
      return ok > 0;
    } catch (e) {
      setNoteStatus({ kind: 'err', text: `Note not sent: ${(e as Error).message}` });
      return false;
    }
  }

  /**
   * One click for a judge with no npub at hand: link THIS browser's own keys (the same persistent keys the
   * Identity tab uses, so a payment lands on a key the visitor controls and can back up — never a throwaway),
   * publish the binding, then resolve it from relays through the normal path.
   */
  const [creating, setCreating] = useState<string>();
  async function createDemoIdentity() {
    setError(undefined);
    try {
      const nostr = ensureLocalNostr();
      const npub = nip19.npubEncode(await nostr.getPublicKey());
      setCreating('Looking for an existing binding…');
      let existing = false;
      try {
        await resolveRecipient(discovery, npub, { network: payNetwork });
        existing = true;
      } catch {
        /* none yet */
      }
      if (!existing) {
        setCreating('Signing the same statement with your BCH key and your Nostr key…');
        const { event } = await createBinding({ bch: localBchSigner(payNetwork), nostr, network: payNetwork });
        const v = verifyChain(event);
        if (!v.ok) throw new Error(`Self-check failed: ${v.reasons.join(', ')}`);
        setCreating(`Publishing to ${discovery.relays.length} relays…`);
        const r = await discovery.publish(event);
        if (!r.some((x) => x.ok)) throw new Error('No relay accepted the binding — check Settings → relays.');
      }
      save('hermes.myNpub', npub);
      setInput(npub);
      setCreating(undefined);
      await resolveFor(npub);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(undefined);
    }
  }

  async function resolveFor(value: string) {
    const v = value.trim();
    if (!v) return;
    setResolving(true);
    setError(undefined);
    setRecipient(undefined);
    setTxid(undefined);
    setReceipt(undefined);
    setNoteStatus(undefined);
    setConfirmMainnet(false);
    try {
      setRecipient(await resolveRecipient(discovery, v, { network: payNetwork }));
      setResolvedInput(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  /** G6: build (and for the browser key, sign) the transaction without broadcasting it; show inputs, outputs, bytes, fee. */
  async function makePreview() {
    if (!recipient) return;
    setError(undefined);
    try {
      if (assetError) throw new Error(assetError);
      if (amountError) throw new Error(amountError);
      const isToken = asset !== 'BCH';
      const value = isToken ? parseUnits(amount, token!.decimals) : parseUnits(amount, 8);
      const to = isToken ? recipient.card.tokenAddr : recipient.card.addr;
      const ref = paymentMemo(memo);
      if (payer === 'local') {
        const p = provider(payNetwork);
        const w = localWallet(payNetwork);
        const utxos = [...(await p.getUtxos(w.address)), ...(await p.getUtxos(w.tokenAddress))] as S[];
        const b = buildPayment({
          provider: p,
          from: w.address,
          fromTokenAddr: w.tokenAddress,
          utxos,
          to,
          asset: isToken ? { kind: 'token', category: token!.category, amount: value } : { kind: 'bch', satoshis: value },
          memo: ref,
          signer: new SignatureTemplate(w.signer.privateKey),
        });
        setPreview(previewBuilder(b, w.address));
      } else setPreview(estimatePreview(1, { tokenOutputs: isToken ? 1 : 0, memo: ref, paying: isToken ? 1000n : value }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function send() {
    if (!recipient || !preview) return;
    setSending(true);
    setError(undefined);
    setTxid(undefined);
    setReceipt(undefined);
    setNoteStatus(undefined);
    try {
      const p = provider(payNetwork);
      const ref = paymentMemo(memo);
      const isToken = asset !== 'BCH';
      if (assetError) throw new Error(assetError);
      if (amountError) throw new Error(amountError);
      const value = isToken ? parseUnits(amount, token!.decimals) : parseUnits(amount, 8);
      const to = isToken ? recipient.card.tokenAddr : recipient.card.addr;
      let id: string;
      let from: string | undefined;
      if (payer === 'wizard') {
        if (wc.state !== 'connected' || !wc.manager) throw new Error('Connect a WizardConnect wallet first (top right), or pay with the browser key.');
        const outputs = isToken ? [{ to, amount: 1000n, token: { category: token!.category, amount: value } }] : [{ to, amount: value }];
        const r = await wcSendOutputs({
          manager: wc.manager,
          provider: p,
          network: payNetwork,
          outputs,
          tokenInputs: isToken ? { category: token!.category, amount: value } : undefined,
          opReturn: ref ? ['HRMS', ref] : undefined,
          userPrompt: `Hermes Pay → ${recipient.card.profile?.name ?? short(recipient.card.npub)}`,
        });
        id = r.txid;
      } else {
        // Broadcast exactly the transaction that was previewed (same inputs, outputs and fee).
        if (!preview.hex) throw new Error('Preview the transaction again');
        id = await p.sendRawTransaction(preview.hex);
        from = localWallet(payNetwork).address;
      }
      setTxid(id);
      setReceipt(
        buildReceipt({
          network: payNetwork,
          txid: id,
          explorer: explorerTxUrl(payNetwork, id),
          asset: isToken ? `${assetLabel} (${token!.category})` : 'BCH',
          memo: ref,
          fee: preview.basis === 'exact' ? preview.fee : undefined,
          bytes: preview.basis === 'exact' ? preview.bytes : undefined,
          from,
          recipients: [receiptLine(recipient, to, amount)],
        }),
      );
      remember(id, false);
      if (notify && (await sendNote(id))) {
        setHistory((h) => {
          const next = h.map((x) => (x.txid === id ? { ...x, note: true } : x));
          save(HISTORY_KEY, next);
          return next;
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  function payAgain(h: PaidEntry) {
    setAmount(h.amount);
    const a = h.asset === 'BCH' ? 'BCH' : h.asset === pusd?.symbol ? 'PUSD' : h.asset === fldch?.symbol ? 'FLDCH' : 'BCH';
    setAsset(a);
    setMemo(h.memo ?? '');
    setInput(h.to);
    void resolveFor(h.to);
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  const c = recipient?.card;
  const stale = !!c && input.trim() !== resolvedInput;
  const blockers = [
    !c?.payable && 'this identity has unresolved warnings',
    stale && 'the input changed — press Find again',
    assetError,
    amountError,
    payNetwork === 'mainnet' && !confirmMainnet && 'tick the mainnet confirmation',
    payer === 'wizard' && wc.state !== 'connected' && 'connect a wallet (or choose Browser key)',
  ].filter((x): x is string => !!x);
  const canSend = !!c && blockers.length === 0 && !sending;
  const rawAddr = isRawAddress(input) ? input.trim() : undefined;
  const pickScanned = (sc: ReturnType<typeof parseScanned>) => {
    if (sc.kind === 'paylink') return applyLink(sc.link);
    if (sc.kind !== 'recipient') return;
    setInput(sc.value);
    if (sc.amount) setAmount(sc.amount);
    void resolveFor(sc.value);
  };

  return (
    <div className="stack" ref={topRef}>
      <div className="hero">
        <HeroArt kind="pay" />
        <h1>Pay a person, not an address.</h1>
        <p>
          Paste an npub or a name. Hermes finds the Bitcoin Cash address they signed for and checks both signatures before you pay.
        </p>
      </div>

      <Card>
        <form
          className="row r3-findrow"
          onSubmit={(e) => {
            e.preventDefault();
            // A pasted pay link (or nostr: / bitcoincash: URI) works like a scanned one.
            const sc = parseScanned(input);
            if (sc.kind === 'paylink' || (sc.kind === 'recipient' && sc.value !== input.trim())) return pickScanned(sc);
            void resolveFor(input);
          }}
        >
          <input
            className="grow big"
            placeholder="npub1…, name@domain or hex key"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
            spellCheck={false}
            aria-label="Recipient"
          />
          <button className="primary" disabled={!input.trim() || resolving}>
            {resolving ? 'Looking up…' : 'Find'}
          </button>
          <QrScan onResult={pickScanned} />
        </form>
        {rawAddr && (
          <AddressGuardBox
            address={rawAddr}
            onPayOwner={(npub) => {
              setInput(npub);
              void resolveFor(npub);
            }}
          />
        )}
        {!myNpub && !input && (
          <div className="row wrap small">
            <span className="muted">No npub at hand?</span>
            <button className="link" onClick={() => void createDemoIdentity()} disabled={!!creating || resolving}>
              Create my Hermes ID in one click
            </button>
          </div>
        )}
        {creating && <Status kind="info">{creating}</Status>}
        {myNpub && !input && (
          <button
            className="link"
            onClick={() => {
              setInput(myNpub);
              void resolveFor(myNpub);
            }}
          >
            Try it with my own identity ({short(myNpub, 12, 4)})
          </button>
        )}
        {resolving && <Status kind="info">Asking relays for the binding and verifying both signatures…</Status>}
        {error && <Status kind="err">{error}</Status>}
      </Card>

      {c && (
        <Card
          title={
            <span className="who">
              {c.profile?.picture && <img src={c.profile.picture} alt="" width={36} height={36} />}
              <span>
                {c.profile?.displayName || c.profile?.name || 'Nostr identity'}
                <small className="mono">{short(c.npub, 14, 6)}</small>
              </span>
            </span>
          }
          aside={<span className={c.payable ? 'stamp' : 'stamp warn'}>{c.payable ? 'Verified' : 'Check warnings'}</span>}
        >
          <ContactBadge r={recipient!} typed={resolvedInput} />
          <ul className="checks">
            <li className="ok">BCH key signed this Nostr key</li>
            <li className="ok">Nostr key signed this BCH key</li>
            <li className="ok">
              Version {c.version} {c.rotations > 0 ? `(rotation chain of ${c.rotations} verified)` : '(original binding)'}
            </li>
            <li className="ok">First seen {new Date(c.firstSeen * 1000).toLocaleDateString('en-US')}</li>
            {nip05.map((n) => (
              <li key={n.name} className={n.status === 'match' ? 'ok' : n.status === undefined ? 'pending' : 'bad'} data-nip05={n.status ?? 'checking'}>
                NIP-05 {n.name} {n.status === undefined ? '(checking…)' : NIP05_TEXT[n.status]}
                {n.typed && n.status === 'match' && <small> · the name you typed</small>}
              </li>
            ))}
          </ul>
          {c.warnings.map((w) => (
            <Status key={w.code + w.message} kind={w.code === 'fork' || w.code === 'nft-mismatch' ? 'err' : 'warn'}>
              {w.message}
            </Status>
          ))}
          {nip05.some((n) => n.status === 'mismatch') && (
            <Status kind="warn">The profile claims a NIP-05 name that belongs to someone else. The BCH ⇄ Nostr binding itself is valid — make sure this npub is the person you mean.</Status>
          )}
          <div className="kv">
            <span>Pays to</span>
            <code className="mono">{asset === 'BCH' ? c.addr : c.tokenAddr}</code>
          </div>

          <div className="row wrap">
            <div className="seg" role="group" aria-label="Asset">
              <button className={asset === 'BCH' ? 'on' : ''} onClick={() => setAsset('BCH')}>
                BCH
              </button>
              <button className={asset === 'PUSD' ? 'on' : ''} onClick={() => setAsset('PUSD')} title={pusd ? 'ParyonUSD stablecoin' : 'PUSD not configured'}>
                {pusd?.symbol ?? 'PUSD'}
              </button>
              {fldch && (
                <button className={asset === 'FLDCH' ? 'on' : ''} onClick={() => setAsset('FLDCH')}>
                  {fldch.symbol}
                </button>
              )}
              <button className={asset === 'TOKEN' ? 'on' : ''} onClick={() => setAsset('TOKEN')} title="Any fungible CashToken by category id">
                Other token
              </button>
            </div>
            <input className="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
            <input className="grow" placeholder="Reference (optional, on-chain)" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={64} />
          </div>
          {asset === 'TOKEN' && (
            <input
              className="mono"
              placeholder="CashToken category id (64 hex)"
              value={tokenCategory}
              onChange={(e) => setTokenCategory(e.target.value.trim().toLowerCase())}
              aria-label="Token category"
              spellCheck={false}
            />
          )}
          {asset !== 'BCH' && token && (
            <p className="muted small">
              {token.name ?? token.symbol} · {token.decimals} decimals ({token.source === 'bcmr' ? 'from BCMR metadata' : 'from config'}) · sent to their token-aware address
            </p>
          )}

          <div className="row wrap">
            <div className="seg" role="group" aria-label="Pay from">
              <button className={payer === 'wizard' ? 'on' : ''} onClick={() => setPayer('wizard')}>
                WizardConnect wallet
              </button>
              <button className={payer === 'local' ? 'on' : ''} onClick={() => setPayer('local')}>
                Browser key
              </button>
            </div>
            {payer === 'wizard' && wc.state !== 'connected' && <span className="muted">Connect a wallet (top right) to pay.</span>}
            {payer === 'local' && (
              <span className="muted small">
                Browser key {short(localWallet(payNetwork).address, 18, 6)} <Copy text={localWallet(payNetwork).address} /> · balance{' '}
                {localBalance === undefined ? '…' : `${formatBch(localBalance)} BCH`}
                {localBalance === 0n && ' — send a little BCH to this address first'}
              </span>
            )}
          </div>

          {payNetwork === 'mainnet' && (
            <label className="confirm">
              <input type="checkbox" checked={confirmMainnet} onChange={(e) => setConfirmMainnet(e.target.checked)} /> I understand this sends real{' '}
              {assetLabel} on mainnet.
            </label>
          )}
          <label className="confirm">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Send them an encrypted note over Nostr (amount,
            reference, txid) — only they can read it
          </label>
          {preview && <TxPreviewView p={preview} network={payNetwork} />}
          {!preview ? (
            <button className="primary wide" disabled={!canSend} onClick={() => void makePreview()}>
              Review fee &amp; size
            </button>
          ) : (
            <button className="primary wide" disabled={!canSend} onClick={() => void send()}>
              {sending ? 'Signing…' : `Send ${amount} ${assetLabel}`}
            </button>
          )}
          {!sending && !txid && blockers.length > 0 && <p className="muted small">To send: {blockers.join(' · ')}.</p>}
          {txid && (
            <Status kind="ok">
              Sent ✔ <TxLink network={payNetwork} txid={txid} /> — saved to “Payment history” below. {receipt && <ReceiptButton receipt={receipt} />}
            </Status>
          )}
          {noteStatus && <Status kind={noteStatus.kind}>{noteStatus.text}</Status>}
          <details>
            <summary>Share a link to pay {c.profile?.name ?? 'this person'}</summary>
            <PayLinkBox link={{ to: c.npub, amount, asset: asset === 'TOKEN' ? tokenCategory || undefined : asset === 'FLDCH' ? fldch?.category : asset, memo: paymentMemo(memo) }} />
          </details>
        </Card>
      )}

      {!c && (
        <ol className="flow" aria-label="How it works">
          <li>
            <span className="flow-dot">1</span>
            <b>Link</b>
            <p>Your BCH key and Nostr key sign one statement.</p>
          </li>
          <li>
            <span className="flow-dot">2</span>
            <b>Find</b>
            <p>Anyone fetches it from relays and checks both signatures.</p>
          </li>
          <li>
            <span className="flow-dot">3</span>
            <b>Pay</b>
            <p>Funds go to the verified address. Nothing to copy.</p>
          </li>
        </ol>
      )}

      {!c && (
        <>
          <Section title="Checked before every payment" sub="Hermes will not pay an address it cannot verify.">
            <FeatureGrid
              items={[
                { title: 'Both signatures', text: 'The BCH key and the Nostr key signed the same statement.' },
                { title: 'Key rotations', text: 'Every change of address is signed by the key it replaces.' },
                { title: 'Lookalike addresses', text: 'A pasted address that only resembles a known one is flagged before you send.' },
                { title: 'Name checks', text: 'A NIP-05 name is matched against the npub it claims.' },
              ]}
            />
          </Section>
          <Section title="Works with what you have">
            <FeatureGrid
              items={[
                { title: 'Your wallet', text: 'Sign with any WizardConnect wallet, or with a key kept in this browser.' },
                { title: 'Nostr extensions', text: 'Use a NIP-07 extension; your Nostr key never leaves it.' },
                { title: 'Pay links and QR', text: 'Share a link that opens your verified card with the amount filled in.' },
                { title: 'BCH and CashTokens', text: 'Send BCH, PUSD or any fungible CashToken by category.' },
              ]}
            />
          </Section>
        </>
      )}

      <More>
      <RequestCard myNpub={myNpub} pusd={pusd} />
      <BatchPay />
      <ContactsCard
        onPay={(npub) => {
          setInput(npub);
          void resolveFor(npub);
          topRef.current?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <NotesInbox />

      <Card
        title="Payment history"
        open={history.length > 0}
        aside={
          history.length > 0 && (
            <button
              className="link"
              onClick={() => {
                if (!confirm('Forget the payment history stored in this browser? (The transactions stay on-chain.)')) return;
                setHistory([]);
                save(HISTORY_KEY, []);
              }}
            >
              clear
            </button>
          )
        }
      >
        {history.length === 0 ? (
          <p className="muted small">No payments yet. Payments sent from this browser appear here; the list never leaves your device.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>To</th>
                  <th>Amount</th>
                  <th>Transaction</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.txid}>
                    <td className="small">{new Date(h.at).toLocaleString('en-US')}</td>
                    <td>
                      {h.name ?? short(h.to, 12, 4)}
                      {h.memo && <small className="muted"> · {h.memo}</small>}
                      {h.note && <small className="muted"> · note sent</small>}
                    </td>
                    <td className="mono">
                      {h.amount} {h.asset}
                    </td>
                    <td>
                      <TxLink network={h.network as 'mainnet'} txid={h.txid} /> {h.network !== payNetwork && <NetBadge network={h.network} />}
                    </td>
                    <td>
                      <button className="link" onClick={() => payAgain(h)}>
                        pay again
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </More>
    </div>
  );
}

/** Link + QR + copy for a pay link (F8). */
function PayLinkBox({ link }: { link: PayLink }) {
  const url = payLinkUrl(appBase(), link);
  return (
    <div className="row wrap paylink">
      <Qr value={url} size={168} />
      <div className="grow">
        <code className="mono wrap-any" data-paylink>
          {url}
        </code>
        <div className="row">
          <Copy text={url} />
          <a className="link" href={url} target="_blank" rel="noreferrer">
            open
          </a>
        </div>
        <p className="muted small">Whoever opens it (or scans the QR) sees the verified card with the amount and reference filled in.</p>
      </div>
    </div>
  );
}

/** F8: ask to be paid — your identity as a link and QR, optionally with an amount (an invoice). */
function RequestCard({ myNpub, pusd }: { myNpub: string | null; pusd?: TokenMeta }) {
  const [who, setWho] = useState(myNpub ?? '');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<'BCH' | 'PUSD'>('BCH');
  const [memo, setMemo] = useState('');
  const kind = who.trim() ? parseRecipient(who).kind : 'invalid';
  const okWho = kind === 'nostr' || kind === 'nip05';
  const okAmount = !amount || /^\d+(\.\d+)?$/.test(amount.trim());
  return (
    <Card title="Request a payment">
      {!myNpub && (
        <p className="muted small">
          Link your BCH and Nostr keys in <a href="#identity">Identity</a> first — then your npub is filled in here. Or paste any linked npub / name.
        </p>
      )}
      <div className="row wrap">
        <input className="grow mono" placeholder="Your npub or name@domain" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Pay link recipient" spellCheck={false} />
      </div>
      <div className="row wrap">
        <div className="seg">
          <button className={asset === 'BCH' ? 'on' : ''} onClick={() => setAsset('BCH')}>
            BCH
          </button>
          <button className={asset === 'PUSD' ? 'on' : ''} onClick={() => setAsset('PUSD')} disabled={!pusd} title={pusd ? '' : 'PUSD not configured'}>
            PUSD
          </button>
        </div>
        <input className="amount" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Requested amount" />
        <input className="grow" placeholder="Reference, e.g. invoice 7 (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={64} aria-label="Requested reference" />
      </div>
      {who.trim() && !okWho && <Status kind="warn">That isn’t an npub, hex key or NIP-05 name.</Status>}
      {!okAmount && <Status kind="warn">Amount must be a plain decimal like 0.001.</Status>}
      {okWho && okAmount && <PayLinkBox link={{ to: who.trim(), amount: amount.trim() || undefined, asset: amount.trim() ? asset : undefined, memo: paymentMemo(memo) }} />}
      {okWho && okAmount && <RequestWatcher who={who.trim()} amount={amount.trim()} asset={asset} pusd={pusd} memo={paymentMemo(memo)} />}
    </Card>
  );
}

/** F11 (recipient side): decrypt Hermes payment notes sent to this browser's Nostr identity. */
function NotesInbox() {
  const { discovery, nostrMode, payNetwork } = useHermes();
  const [notes, setNotes] = useState<PaymentNote[]>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [me, setMe] = useState<string>();
  const useExt = nostrMode === 'nip07' && !!nip07();

  async function check() {
    setBusy(true);
    setErr(undefined);
    try {
      let pk: string;
      let decrypt: (sender: string, content: string) => Promise<string>;
      if (useExt) {
        const ext = nip07()!;
        if (!ext.nip04) throw new Error('Your Nostr extension does not support NIP-04 decryption');
        pk = await ext.getPublicKey();
        decrypt = (s, ct) => ext.nip04!.decrypt(s, ct);
      } else {
        const nsec = getLocalNsec();
        if (!nsec) throw new Error('This browser has no Nostr key yet — link an identity in the Identity tab first.');
        const secret = nip19.decode(nsec).data as Uint8Array;
        pk = getPublicKey(secret);
        decrypt = localNoteDecrypt(secret);
      }
      setMe(pk);
      const { events, answered } = await discovery.query({ kinds: [4], '#p': [pk], limit: 100 });
      if (answered === 0) throw new Error('No relay answered');
      setNotes(await readPaymentNotes(events, pk, decrypt));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The browser key can be read without a prompt; an extension asks first, so that one is manual.
  useEffect(() => {
    if (!useExt && getLocalNsec()) void check();
  }, []);

  return (
    <Card
      title="Payment notes"
      aside={
        <button className="link" onClick={() => void check()} disabled={busy}>
          {busy ? 'checking…' : notes ? 'refresh' : 'check'}
        </button>
      }
    >
      <p className="muted small">
        Encrypted notes (NIP-04, tagged “{PAYMENT_NOTE_TAG}”) that payers sent to {me ? <span className="mono">{short(npubOf(me), 12, 6)}</span> : 'your Nostr key'}
        {useExt ? ' (via your extension)' : ' (this browser’s key)'}. Only you can decrypt them; check the transaction on the explorer before trusting the amount.
      </p>
      {err && <Status kind="err">{err}</Status>}
      {notes && notes.length === 0 && <p className="muted small">No payment notes yet.</p>}
      {notes && notes.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <tbody>
              {notes.map((n) => (
                <tr key={n.id}>
                  <td className="small">{new Date(n.at * 1000).toLocaleString('en-US')}</td>
                  <td className="mono small">from {short(npubOf(n.from), 10, 4)}</td>
                  <td className="mono">
                    {n.amount} {isCategory(n.asset) ? short(n.asset, 6, 4) : n.asset}
                    {n.memo && <small className="muted"> · {n.memo}</small>}
                  </td>
                  <td>
                    <TxLink network={payNetwork} txid={n.txid} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
