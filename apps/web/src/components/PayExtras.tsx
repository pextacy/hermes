/**
 * Round 3 Pay features (G1–G7) for the Pay tab. Pure logic lives in packages/pay/src/round3.ts.
 */
import { useEffect, useRef, useState } from 'react';
import {
  MAX_BATCH,
  addressGuard,
  buildBatchPayment,
  buildReceipt,
  contactDrift,
  detectPayment,
  estimateP2pkhSize,
  findContact,
  normalizeContacts,
  parseBatch,
  parseScanned,
  previewBuilder,
  receiptFilename,
  receiptJson,
  resolveRecipient,
  safePlain,
  watchBaseline,
  type AddressGuard,
  type Contact,
  type PaymentReceipt,
  type ResolvedRecipient,
  type Scanned,
  type TxPreview,
  type WatchWant,
} from '@hermes/pay';
import { npubOf, parseRecipient } from '@hermes/id';
import { PLAIN_DUST_SATS, explorerTxUrl, formatBch, parseUnits, type BchNetwork, type TokenMeta } from '@hermes/chain';
import { SignatureTemplate, type Utxo } from 'cashscript';
import { useHermes } from '../lib/context';
import { localWallet } from '../lib/keys';
import { wcSendOutputs } from '../lib/wizard';
import { load, save } from '../lib/storage';
import { Card, NetBadge, Status, TxLink, short } from './ui';

type S = Utxo & { lockingBytecode: string };
export const CONTACTS_KEY = 'hermes.contacts';

// ───────────────────────────── G4 contacts store ─────────────────────────────

const listeners = new Set<() => void>();
export const loadContacts = () => normalizeContacts(load<unknown>(CONTACTS_KEY, []));
export function saveContacts(list: Contact[]) {
  save(CONTACTS_KEY, list);
  for (const l of listeners) l();
}
/** Contacts shared across the Pay tab's cards (re-renders every user when one changes). */
export function useContacts(): [Contact[], (list: Contact[]) => void] {
  const [list, setList] = useState(loadContacts);
  useEffect(() => {
    const l = () => setList(loadContacts());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return [list, saveContacts];
}

// ───────────────────────────── G5 receipt download ─────────────────────────────

export function downloadText(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ReceiptButton({ receipt }: { receipt: PaymentReceipt }) {
  return (
    <button className="link" data-receipt onClick={() => downloadText(receiptFilename(receipt), receiptJson(receipt))}>
      Download receipt (JSON)
    </button>
  );
}

export const receiptLine = (r: ResolvedRecipient, address: string, amount: string) => ({
  to: r.card.npub,
  name: r.card.profile?.displayName || r.card.profile?.name || undefined,
  address,
  amount,
  bindingEventId: r.identity.current.event.id,
  bindingVersion: r.card.version,
});

// ───────────────────────────── G6 preview view ─────────────────────────────

export function TxPreviewView({ p, network }: { p: TxPreview; network: BchNetwork }) {
  return (
    <div className="r3-preview" data-preview={p.basis}>
      <div className="r3-preview-head">
        <b>Transaction preview</b> <NetBadge network={network} />{' '}
        <span className={`pill ${p.basis === 'exact' ? 'pill-ok' : 'pill-warn'}`}>{p.basis === 'exact' ? 'built & signed locally, not broadcast' : 'estimate — your wallet picks the coins'}</span>
      </div>
      <dl className="r3-kv">
        <dt>Inputs</dt>
        <dd>{p.inputs}</dd>
        <dt>Outputs</dt>
        <dd>{p.outputs}</dd>
        <dt>Size</dt>
        <dd>{p.bytes} bytes</dd>
        <dt>Fee</dt>
        <dd>
          {p.fee.toString()} sats ({p.feeRate} sat/B)
        </dd>
        {p.basis === 'exact' && (
          <>
            <dt>Inputs total</dt>
            <dd>{formatBch(p.inputSats)} BCH</dd>
            <dt>Change back</dt>
            <dd>{formatBch(p.changeSats)} BCH</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Wallet path: we don't know the wallet's coins before it signs, so estimate one P2PKH input. */
export function estimatePreview(outputs: number, opts: { tokenOutputs?: number; memo?: string; paying: bigint }): TxPreview {
  const change = 1;
  const bytes = estimateP2pkhSize({ inputs: 1, outputs: outputs + change, tokenOutputs: opts.tokenOutputs, opReturnBytes: opts.memo ? 4 + opts.memo.length : 0 });
  const fee = BigInt(bytes);
  return { inputs: 1, outputs: outputs + change + (opts.memo ? 1 : 0), bytes, fee, feeRate: 1, inputSats: 0n, outputSats: opts.paying, changeSats: 0n, basis: 'estimate' };
}

// ───────────────────────────── G7 QR scan ─────────────────────────────

interface Detector {
  detect(src: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = { new (o?: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };
const detectorCtor = () => (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;

export async function qrSupport(): Promise<'ok' | 'no-detector' | 'no-qr'> {
  const D = detectorCtor();
  if (!D) return 'no-detector';
  try {
    const f = (await D.getSupportedFormats?.()) ?? ['qr_code'];
    return f.includes('qr_code') ? 'ok' : 'no-qr';
  } catch {
    return 'no-qr';
  }
}

/** Camera (BarcodeDetector) or picture upload; falls back to "paste it" when the browser can't. */
export function QrScan({ onResult }: { onResult: (s: Exclude<Scanned, { kind: 'invalid' }>) => void }) {
  const [open, setOpen] = useState(false);
  const [support, setSupport] = useState<'ok' | 'no-detector' | 'no-qr'>();
  const [msg, setMsg] = useState<{ kind: 'info' | 'warn' | 'err'; text: string }>();
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef<() => void>(() => undefined);

  useEffect(() => () => stop.current(), []);

  function handle(raw: string) {
    const s = parseScanned(raw);
    if (s.kind === 'invalid') return setMsg({ kind: 'err', text: `QR not usable: ${s.reason}.` });
    close();
    onResult(s);
  }

  function close() {
    stop.current();
    setOpen(false);
  }

  async function start() {
    setMsg(undefined);
    setOpen(true);
    const sup = await qrSupport();
    setSupport(sup);
    if (sup !== 'ok') return;
    if (!navigator.mediaDevices?.getUserMedia) return setMsg({ kind: 'warn', text: 'No camera access in this browser — upload a picture of the QR, or paste the npub / link.' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      // the <video> mounts with the panel; wait for React to commit it
      for (let i = 0; i < 20 && !video.current; i++) await new Promise((r) => setTimeout(r, 25));
      const v = video.current;
      if (!v) throw new Error('video element not ready');
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      const det = new (detectorCtor()!)({ formats: ['qr_code'] });
      let live = true;
      const frame = document.createElement('canvas');
      const timer = setInterval(async () => {
        if (!live || v.readyState < 2 || !v.videoWidth) return;
        try {
          // detect on a canvas copy of the frame (more reliable across browsers than the <video> itself)
          frame.width = v.videoWidth;
          frame.height = v.videoHeight;
          frame.getContext('2d')!.drawImage(v, 0, 0);
          const codes = await det.detect(frame);
          if (live && codes[0]?.rawValue) handle(codes[0].rawValue);
        } catch {
          /* frame not ready */
        }
      }, 250);
      stop.current = () => {
        live = false;
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        stop.current = () => undefined;
      };
      setMsg({ kind: 'info', text: 'Point the camera at an npub or Hermes pay-link QR…' });
    } catch (e) {
      setMsg({ kind: 'warn', text: `Camera unavailable (${(e as Error).name || (e as Error).message}) — upload a picture of the QR, or paste the npub / link.` });
    }
  }

  async function fromFile(f: File | undefined) {
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const codes = await new (detectorCtor()!)({ formats: ['qr_code'] }).detect(bmp);
      if (!codes[0]) return setMsg({ kind: 'err', text: 'No QR code found in that picture.' });
      handle(codes[0].rawValue);
    } catch (e) {
      setMsg({ kind: 'err', text: `Could not read that picture: ${(e as Error).message}` });
    }
  }

  return (
    <>
      <button type="button" className="r3-scan" onClick={() => (open ? close() : void start())} title="Scan an npub or pay-link QR with the camera">
        {open ? 'Close scanner' : 'Scan QR'}
      </button>
      {open && (
        <div className="r3-scanner" data-scanner={support ?? 'checking'}>
          <video ref={video} muted playsInline className="r3-video" hidden={support !== 'ok'} />
          {support && support !== 'ok' && (
            <Status kind="warn">
              QR scanning isn’t supported in this browser ({support === 'no-detector' ? 'no BarcodeDetector API' : 'BarcodeDetector can’t read QR codes here'}) — it works in Chrome / Edge on
              Android, macOS and ChromeOS. Paste the npub, name@domain or pay link into the box instead.
            </Status>
          )}
          {support === 'ok' && (
            <label className="small muted">
              or read a picture of the QR: <input type="file" accept="image/*" aria-label="QR picture" onChange={(e) => void fromFile(e.target.files?.[0])} />
            </label>
          )}
          {msg && <Status kind={msg.kind}>{msg.text}</Status>}
        </div>
      )}
    </>
  );
}

// ───────────────────────────── G3 address-poisoning guard ─────────────────────────────

/** A raw cashaddr was pasted: reverse-look it up on relays (`#i` = bch:<addr>) and say whose it is. */
export function AddressGuardBox({ address, onPayOwner }: { address: string; onPayOwner: (npub: string) => void }) {
  const { discovery } = useHermes();
  const [contacts] = useContacts();
  const [state, setState] = useState<{ g?: AddressGuard; name?: string; busy: boolean; err?: string }>({ busy: true });
  useEffect(() => {
    let live = true;
    setState({ busy: true });
    const known = contacts.flatMap((c) => [
      { addr: c.addr, label: c.name ?? short(c.npub, 12, 4) },
      { addr: c.tokenAddr, label: c.name ?? short(c.npub, 12, 4) },
    ]);
    const t = setTimeout(async () => {
      try {
        let r = await discovery.resolve(address);
        if (!live) return;
        // Relays keep only the latest version of a binding, so an address from an older version no longer
        // reverse-resolves. If it is an address you saved for a contact, re-resolve that contact instead.
        const plain = safePlain(address);
        const saved = contacts.find((c) => safePlain(c.addr) === plain || safePlain(c.tokenAddr) === plain);
        if (!r.identity && saved) {
          const again = await discovery.resolve(saved.npub);
          if (!live) return;
          if (again.identity) r = again;
        }
        const cur = r.identity?.current;
        const name = cur ? contacts.find((c) => c.nostr === cur.nostr)?.name : undefined;
        if (!r.identity && r.answered === 0) return setState({ busy: false, err: 'No relay answered — cannot check who owns this address.', g: addressGuard(address, undefined, known) });
        setState({ busy: false, g: addressGuard(address, cur, known), name });
      } catch (e) {
        if (live) setState({ busy: false, err: (e as Error).message });
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address]);
  const g = state.g;
  return (
    <div className="r3-guard" data-guard={state.busy ? 'checking' : (g?.kind ?? 'error')}>
      {state.busy && <Status kind="info">Raw address pasted — asking relays which Hermes ID (if any) owns it…</Status>}
      {state.err && <Status kind="warn">{state.err}</Status>}
      {g?.lookalikes.map((l) => (
        <Status key={l.addr} kind="err">
          Possible address poisoning: this address starts and ends like {l.label}’s ({short(l.addr, 16, 6)}) but is a DIFFERENT address. Do not pay it unless you got it from them directly.
        </Status>
      ))}
      {g?.kind === 'owner' && (
        <Status kind="ok">
          This address belongs to Hermes ID {state.name ? <b>{state.name}</b> : null} <span className="mono">{short(npubOf(g.nostr), 14, 6)}</span> (binding version {g.version}, both signatures
          verified).{' '}
          <button className="link" onClick={() => onPayOwner(npubOf(g.nostr))}>
            Pay them by identity instead
          </button>
        </Status>
      )}
      {g?.kind === 'moved' && (
        <Status kind="warn">
          This address was in an OLDER binding of <span className="mono">{short(npubOf(g.nostr), 14, 6)}</span>; their current verified address (version {g.version}) is{' '}
          <span className="mono">{short(g.currentAddr, 16, 6)}</span>. Hermes pays the current one.{' '}
          <button className="link" onClick={() => onPayOwner(npubOf(g.nostr))}>
            Pay their current address
          </button>
        </Status>
      )}
      {g?.kind === 'unknown' && !state.err && (
        <Status kind="warn">
          No Hermes ID claims this address. Hermes can’t tell who it belongs to — a copied or look-alike address is how address-poisoning steals payments. Ask the recipient for their npub
          instead.
        </Status>
      )}
    </div>
  );
}

// ───────────────────────────── G4 contacts UI ─────────────────────────────

export function ContactsCard({ onPay }: { onPay: (npub: string) => void }) {
  const [contacts, setContacts] = useContacts();
  return (
    <Card title="Contacts" aside={<span className="muted small">{contacts.length} saved</span>}>
      {contacts.length === 0 ? (
        <p className="muted small">Save a verified identity from its card (“Save contact”). Every time you pay a contact Hermes re-verifies the binding from relays and flags it if the version changed.</p>
      ) : (
        <div className="table-scroll">
          <table className="table" data-contacts>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.npub}>
                  <td>
                    <b>{c.name ?? 'Unnamed'}</b> <small className="mono muted">{short(c.npub, 12, 4)}</small>
                  </td>
                  <td className="small">version {c.version}</td>
                  <td className="mono small">{short(c.addr, 14, 6)}</td>
                  <td>
                    <button className="link" onClick={() => onPay(c.npub)}>
                      pay
                    </button>{' '}
                    <button
                      className="link"
                      onClick={() => {
                        if (confirm(`Remove ${c.name ?? 'this contact'}?`)) setContacts(contacts.filter((x) => x.npub !== c.npub));
                      }}
                    >
                      remove
                    </button>
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

// ───────────────────────────── G1 request watcher ─────────────────────────────

export function RequestWatcher({ who, amount, asset, pusd, memo }: { who: string; amount: string; asset: 'BCH' | 'PUSD'; pusd?: TokenMeta; memo?: string }) {
  const { discovery, payNetwork, provider } = useHermes();
  const [state, setState] = useState<{ phase: 'idle' | 'resolving' | 'watching' | 'paid' | 'error'; text?: string; addr?: string; txid?: string; checks?: number; received?: string }>({ phase: 'idle' });
  const stopRef = useRef<() => void>(() => undefined);
  useEffect(() => () => stopRef.current(), []);
  // A different request invalidates the watch.
  useEffect(() => {
    stopRef.current();
    setState({ phase: 'idle' });
  }, [who, amount, asset]);

  async function start() {
    stopRef.current();
    setState({ phase: 'resolving' });
    try {
      const r = await resolveRecipient(discovery, who, { network: payNetwork, withProfile: false });
      const isToken = asset === 'PUSD';
      if (isToken && !pusd) throw new Error('PUSD is not configured on this network');
      const addr = isToken ? r.card.tokenAddr : r.card.addr;
      const want: WatchWant = isToken
        ? { token: { category: pusd!.category, amount: amount ? parseUnits(amount, pusd!.decimals) : 1n } }
        : { sats: amount ? parseUnits(amount, 8) : 1n };
      const p = provider(payNetwork);
      const baseline = watchBaseline(await p.getUtxos(addr));
      let checks = 0;
      let live = true;
      setState({ phase: 'watching', addr, checks });
      const tick = async () => {
        if (!live) return;
        try {
          const found = detectPayment(baseline, (await p.getUtxos(addr)) as never, want);
          checks++;
          if (!live) return;
          if (found) {
            live = false;
            clearInterval(timer);
            const received = isToken ? `${found.received} base units` : `${formatBch(found.received)} BCH`;
            setState({ phase: 'paid', addr, txid: found.txid, checks, received });
          } else setState((s) => ({ ...s, checks }));
        } catch {
          /* transient Electrum error: keep polling */
        }
      };
      const timer = setInterval(() => void tick(), 4000);
      stopRef.current = () => {
        live = false;
        clearInterval(timer);
      };
    } catch (e) {
      setState({ phase: 'error', text: (e as Error).message });
    }
  }

  return (
    <div className="r3-watch" data-watch={state.phase}>
      {state.phase === 'idle' || state.phase === 'error' ? (
        <button className="link" onClick={() => void start()}>
          Watch for this payment
        </button>
      ) : state.phase !== 'paid' ? (
        <button
          className="link"
          onClick={() => {
            stopRef.current();
            setState({ phase: 'idle' });
          }}
        >
          stop watching
        </button>
      ) : null}
      {state.phase === 'resolving' && <Status kind="info">Resolving and verifying the receiving identity…</Status>}
      {state.phase === 'watching' && (
        <Status kind="info">
          <span className="r3-pulse" /> Waiting for {amount ? `${amount} ${asset}` : 'any payment'}
          {memo ? ` (${memo})` : ''} at <span className="mono">{short(state.addr!, 16, 6)}</span> · checked {state.checks}× (every 4 s; outputs already there don’t count)
        </Status>
      )}
      {state.phase === 'paid' && (
        <Status kind="ok">
          <b>Paid ✓</b> {state.received} received in <TxLink network={payNetwork} txid={state.txid!} />
        </Status>
      )}
      {state.phase === 'error' && <Status kind="err">Can’t watch: {state.text}</Status>}
    </div>
  );
}

// ───────────────────────────── G2 batch pay ─────────────────────────────

interface Row {
  line: number;
  to: string;
  amount: string;
  sats?: bigint;
  r?: ResolvedRecipient;
  err?: string;
  drift?: string;
}

export function BatchPay() {
  const { discovery, payNetwork, provider, wc } = useHermes();
  const [contacts] = useContacts();
  const [text, setText] = useState('');
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState<Row[]>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [payer, setPayer] = useState<'wizard' | 'local'>('local');
  const [preview, setPreview] = useState<TxPreview>();
  const [confirmMainnet, setConfirmMainnet] = useState(false);
  const [sent, setSent] = useState<{ txid: string; receipt: PaymentReceipt }>();
  const parsed = parseBatch(text);

  // Any change invalidates what was resolved / previewed.
  useEffect(() => {
    setRows(undefined);
    setPreview(undefined);
    setSent(undefined);
  }, [text, payNetwork]);
  useEffect(() => setPreview(undefined), [memo, payer]);

  async function resolveAll() {
    setErr(undefined);
    setPreview(undefined);
    setSent(undefined);
    setBusy(`Resolving and verifying ${parsed.lines.length} identities…`);
    const out = await Promise.all(
      parsed.lines.map(async (l): Promise<Row> => {
        let sats: bigint | undefined;
        try {
          sats = parseUnits(l.amount, 8);
        } catch {
          return { ...l, err: 'bad amount' };
        }
        if (sats < PLAIN_DUST_SATS) return { ...l, sats, err: `below dust (${PLAIN_DUST_SATS} sats)` };
        try {
          const r = await resolveRecipient(discovery, l.to, { network: payNetwork });
          const c = findContact(contacts, r.card, l.to);
          return { ...l, sats, r, drift: c ? contactDrift(c, r.card)?.message : undefined, err: r.card.payable ? undefined : 'unresolved warnings (fork / NFT mismatch)' };
        } catch (e) {
          return { ...l, sats, err: (e as Error).message };
        }
      }),
    );
    setRows(out);
    setBusy(undefined);
  }

  const ok = rows?.filter((r) => r.r && !r.err) ?? [];
  const total = ok.reduce((n, r) => n + r.sats!, 0n);
  const blockers = [
    parsed.errors.length > 0 && 'fix the lines marked above',
    rows && rows.some((r) => r.err) && 'remove the recipients that did not verify',
    !rows && 'press “Resolve & verify”',
    payNetwork === 'mainnet' && !confirmMainnet && 'tick the mainnet confirmation',
    payer === 'wizard' && wc.state !== 'connected' && 'connect a wallet (or choose Browser key)',
  ].filter((x): x is string => !!x);

  const outputs = () => ok.map((r) => ({ to: r.r!.card.addr, sats: r.sats! }));

  async function doPreview() {
    setErr(undefined);
    try {
      if (payer === 'local') {
        const w = localWallet(payNetwork);
        const p = provider(payNetwork);
        const utxos = (await p.getUtxos(w.address)) as S[];
        setPreview(previewBuilder(buildBatchPayment({ provider: p, from: w.address, utxos, outputs: outputs(), memo: memo || undefined, signer: new SignatureTemplate(w.signer.privateKey) }), w.address));
      } else setPreview(estimatePreview(ok.length, { memo: memo || undefined, paying: total }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function send() {
    if (!preview) return;
    setErr(undefined);
    setBusy('Sending one transaction…');
    try {
      const p = provider(payNetwork);
      let txid: string;
      let from: string | undefined;
      if (payer === 'local') {
        if (!preview.hex) throw new Error('preview again');
        // Broadcast exactly the transaction that was previewed.
        txid = await p.sendRawTransaction(preview.hex);
        from = localWallet(payNetwork).address;
      } else {
        if (wc.state !== 'connected' || !wc.manager) throw new Error('Connect a WizardConnect wallet first');
        const r = await wcSendOutputs({
          manager: wc.manager,
          provider: p,
          network: payNetwork,
          outputs: outputs().map((o) => ({ to: o.to, amount: o.sats })),
          opReturn: memo ? ['HRMS', memo] : undefined,
          userPrompt: `Hermes batch pay → ${ok.length} people`,
        });
        txid = r.txid;
      }
      const receipt = buildReceipt({
        network: payNetwork,
        txid,
        explorer: explorerTxUrl(payNetwork, txid),
        asset: 'BCH',
        memo: memo || undefined,
        fee: preview.basis === 'exact' ? preview.fee : undefined,
        bytes: preview.basis === 'exact' ? preview.bytes : undefined,
        from,
        recipients: ok.map((r) => receiptLine(r.r!, r.r!.card.addr, r.amount)),
      });
      setSent({ txid, receipt });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card title="Pay many people at once" aside={<span className="muted small">BCH · up to {MAX_BATCH}</span>}>
      <p className="muted small">
        One line per person: <code>npub-or-name, amount</code>. Each is resolved and verified from relays, then paid in a single transaction with one output per person.
      </p>
      <textarea className="mono r3-batch" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'npub1…, 0.001\nalice@example.com, 0.0005'} aria-label="Batch lines" spellCheck={false} />
      {parsed.errors.map((e) => (
        <Status key={e.line + e.message} kind="warn">
          Line {e.line}: {e.message}
        </Status>
      ))}
      <div className="row wrap">
        <button className="primary" disabled={!parsed.lines.length || parsed.errors.length > 0 || !!busy} onClick={() => void resolveAll()}>
          Resolve &amp; verify {parsed.lines.length || ''}
        </button>
        <input className="grow" placeholder="Reference for all (optional, on-chain)" value={memo} onChange={(e) => setMemo(e.target.value.replace(/[^\x20-\x7e]/g, ''))} maxLength={64} aria-label="Batch reference" />
      </div>
      {busy && <Status kind="info">{busy}</Status>}
      {rows && (
        <div className="table-scroll">
          <table className="table" data-batch-rows>
            <thead>
              <tr>
                <th>#</th>
                <th>Recipient</th>
                <th>Pays to</th>
                <th>Amount</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line} className={r.err ? 'r3-bad' : ''}>
                  <td className="small">{r.line}</td>
                  <td>
                    {r.r ? (r.r.card.profile?.displayName || r.r.card.profile?.name || short(r.r.card.npub, 12, 4)) : short(r.to, 14, 4)}
                    {r.r && <small className="muted"> · v{r.r.card.version}</small>}
                  </td>
                  <td className="mono small">{r.r ? short(r.r.card.addr, 14, 6) : '—'}</td>
                  <td className="mono">{r.amount} BCH</td>
                  <td className="small">
                    {r.err ? <span className="r3-err">✗ {r.err}</span> : <span className="r3-ok">✓ verified</span>}
                    {r.drift && <div className="r3-err">⚠ {r.drift}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && (
        <>
          <div className="row wrap">
            <span>
              Total <b className="mono">{formatBch(total)} BCH</b> to {ok.length} {ok.length === 1 ? 'person' : 'people'}
            </span>
            <div className="seg" role="group" aria-label="Batch pay from">
              <button className={payer === 'wizard' ? 'on' : ''} onClick={() => setPayer('wizard')}>
                WizardConnect wallet
              </button>
              <button className={payer === 'local' ? 'on' : ''} onClick={() => setPayer('local')}>
                Browser key
              </button>
            </div>
          </div>
          {payNetwork === 'mainnet' && (
            <label className="confirm">
              <input type="checkbox" checked={confirmMainnet} onChange={(e) => setConfirmMainnet(e.target.checked)} /> I understand this sends real BCH on mainnet.
            </label>
          )}
          <div className="row wrap">
            <button disabled={blockers.length > 0 || !ok.length || !!busy} onClick={() => void doPreview()}>
              Preview transaction
            </button>
            <button className="primary" disabled={!preview || blockers.length > 0 || !!busy || !!sent} onClick={() => void send()}>
              Send {formatBch(total)} BCH to {ok.length}
            </button>
          </div>
          {blockers.length > 0 && <p className="muted small">To send: {blockers.join(' · ')}.</p>}
        </>
      )}
      {preview && <TxPreviewView p={preview} network={payNetwork} />}
      {err && <Status kind="err">{err}</Status>}
      {sent && (
        <Status kind="ok">
          Sent ✔ one transaction to {sent.receipt.recipients.length} people: <TxLink network={payNetwork} txid={sent.txid} /> · <ReceiptButton receipt={sent.receipt} />
        </Status>
      )}
    </Card>
  );
}

/** For the single Pay card: is this the contact you saved, and did it change? */
export function ContactBadge({ r, typed }: { r: ResolvedRecipient; typed?: string }) {
  const [contacts, setContacts] = useContacts();
  const saved = findContact(contacts, r.card, typed);
  const drift = saved ? contactDrift(saved, r.card) : undefined;
  const fresh = () => ({
    npub: saved?.npub ?? r.card.npub,
    nostr: r.card.nostr,
    name: r.card.profile?.displayName || r.card.profile?.name || saved?.name,
    addr: r.card.addr,
    tokenAddr: r.card.tokenAddr,
    version: r.card.version,
    bindingId: r.identity.current.event.id,
    network: r.card.network,
    savedAt: Date.now(),
  });
  if (!saved)
    return (
      <div className="row wrap small" data-contact="none">
        <button className="link" disabled={!r.card.payable} onClick={() => setContacts([fresh(), ...contacts])}>
          Save contact
        </button>
        <span className="muted">— re-verified every time you pay them</span>
      </div>
    );
  if (drift)
    return (
      <div data-contact="changed">
        <Status kind="err">
          {saved.name ?? 'Contact'}: {drift.message}{' '}
          <button className="link" onClick={() => setContacts([fresh(), ...contacts.filter((c) => c.npub !== saved.npub)])}>
            Accept version {drift.to}
          </button>
        </Status>
      </div>
    );
  return (
    <p className="small r3-ok" data-contact="match">
      ✓ Matches your saved contact {saved.name ? <b>{saved.name}</b> : null} (version {saved.version}, re-verified just now)
    </p>
  );
}

export const isRawAddress = (v: string) => parseRecipient(v).kind === 'bch';
