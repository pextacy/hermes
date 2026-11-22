/**
 * Swap simulator: a complete USDC ⇄ PUSD atomic swap with no network, no wallet and no testnet funds.
 *
 * Both chains run the real contracts:
 * - EVM: the compiled HermesHTLC + MockUSDC bytecode (packages/evm-htlc) executed by @ethereumjs/vm,
 *   with a controllable block timestamp;
 * - BCH: the HermesHtlc covenant (CashScript) evaluated by the BCH 2026 VM through CashScript's
 *   MockNetworkProvider, built with the same buildLock / buildClaim / buildRefund the live app uses.
 *
 * The secret really travels between chains: whoever claims second reads it from the first claim
 * (BCH unlocking bytecode, or the EVM `Claimed` event). Attacks are attempted along the way (wrong
 * secret, early refund, claim after expiry) and must be rejected by the contracts themselves.
 *
 * Malicious-solver scenarios (`bad-hashlock`, `short-timeout`, `short-amount`): the solver's
 * counter-lock does not match the quote. The taker's verification (verifyCounterLock, the same check
 * the live app relies on) must catch it, so the taker never claims and never reveals its secret; it
 * refunds after T₁ and nothing is lost.
 *
 * Every step carries a plain-language explanation and the raw transactions behind it (BCH tx hex,
 * EVM calldata + decoded logs), so the whole run can be downloaded as a transcript.
 *
 * Kept out of the package index so the solver and CLI never load the EVM.
 */
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { decodeEventLog, decodeErrorResult, encodeFunctionData, decodeFunctionResult, type Abi, type Hex } from 'viem';
import { MockNetworkProvider, randomUtxo, type TransactionBuilder } from 'cashscript';
import { generatePrivateKey, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { walletFromPrivateKey } from '@hermes/chain';
import { hermesHtlcAbi, hermesHtlcBytecode, mockUsdcAbi, mockUsdcBytecode } from '../../evm-htlc/abi.js';
import { buildClaim, buildLock, buildRefund, extractPreimageFromBchTx, htlcContract } from './bch-htlc.js';
import { ACTION_MARGIN_SECONDS, SAFETY_MARGIN_SECONDS, convert, generateSecret, validateTimeouts, type Direction } from './params.js';
import { feeBreakdown, verifyCounterLock, type FeeBreakdown, type LockCheck } from './taker.js';

export type SimAttack = 'bad-hashlock' | 'short-timeout' | 'short-amount';
export type SimScenario = 'happy' | 'refund' | SimAttack;
export type SimActor = 'taker' | 'solver' | 'attacker' | '—';

export const SIM_SCENARIOS: { id: SimScenario; label: string; blurb: string }[] = [
  { id: 'happy', label: 'Atomic swap', blurb: 'Both sides honest: the secret crosses chains and both legs settle.' },
  { id: 'refund', label: 'Solver disappears → refund', blurb: 'The solver never counter-locks; the taker refunds after T₁.' },
  { id: 'bad-hashlock', label: 'Wrong hashlock', blurb: 'The solver locks under a hashlock the taker’s secret cannot open.' },
  { id: 'short-timeout', label: 'Too-short timeout', blurb: 'The solver’s lock expires 10 minutes after locking — no safe time to claim.' },
  { id: 'short-amount', label: 'Short amount', blurb: 'The solver locks 10% less than it quoted.' },
];

/** One EVM call as executed (calldata, gas, revert reason or decoded logs). */
export interface SimEvmCall {
  from: string;
  to: string;
  contract: 'HermesHTLC' | 'MockUSDC';
  fn: string;
  args: string[];
  calldata: string;
  ok: boolean;
  revert?: string;
  gas: string;
  blockTimestamp: number;
  logs: { event: string; args: Record<string, string> }[];
}

/** One BCH transaction: accepted (broadcast to the mock network) or rejected by the VM. */
export interface SimBchTx {
  txid?: string;
  hex?: string;
  accepted: boolean;
  bytes?: number;
  inputs?: number;
  outputs?: number;
  locktime?: number;
  error?: string;
}

export interface SimStep {
  n: number;
  chain: 'EVM' | 'BCH' | 'off-chain';
  actor: SimActor;
  title: string;
  detail: string;
  /** Plain-language "why this step matters" (step-through mode). */
  explain?: string;
  /** Expected result of the step: a normal action succeeds; an attack must be rejected. */
  expect: 'ok' | 'rejected';
  ok: boolean;
  /** Tx id (BCH) / lock id (EVM) when there is one. */
  ref?: string;
  /** EVM gas used or BCH transaction size. */
  cost?: string;
  /** Simulated wall clock (unix seconds) when the step ran. */
  at: number;
  /** EVM calls made in this step. */
  evm?: SimEvmCall[];
  /** BCH transactions made (or rejected) in this step. */
  bch?: SimBchTx[];
  /** Taker's counter-lock checks, when this step is the verification. */
  checks?: LockCheck[];
}

export interface SimBalances {
  taker: { usdc: bigint; pusd: bigint };
  solver: { usdc: bigint; pusd: bigint };
  /** Held by the two HTLCs right now. */
  escrow: { usdc: bigint; pusd: bigint };
}

/** The agreed terms, known before the first step (for the fee breakdown and timeout ladder). */
export interface SimPlan {
  direction: Direction;
  scenario: SimScenario;
  amountIn: bigint;
  amountOut: bigint;
  spreadPpm: number;
  decimalsIn: number;
  decimalsOut: number;
  symbolIn: string;
  symbolOut: string;
  t0: number;
  tFirst: number;
  tSecond: number;
  marginSeconds: number;
  hashlock: string;
  fee: FeeBreakdown;
  contracts: { evmHtlc: string; evmUsdc: string; bchTokenCategory: string };
  parties: { takerEvm: string; solverEvm: string; takerBch: string; solverBch: string };
}

export interface SimResult {
  direction: Direction;
  scenario: SimScenario;
  steps: SimStep[];
  balances: SimBalances;
  start: SimBalances;
  secret: string;
  hashlock: string;
  /** Every expected action succeeded and every attack was rejected. */
  passed: boolean;
  plan: SimPlan;
  /** Contract deployment and funding calls made before step 1. */
  setup: { evm: SimEvmCall[]; bch: SimBchTx[] };
}

const USDC_DEC = 6;
const PUSD_DEC = 2;
const T_FIRST = 3 * 3600;
const T_SECOND = 3600;
/** Each party is funded with this much of each token (base units). */
const FUND_USDC = 10_000_000_000n; // 10,000 USDC
const FUND_PUSD = 1_000_000n; // 10,000.00 tPUSD
export const SIM_LIMITS = { maxUsdc: 5_000_000_000n, maxPusd: 500_000n, maxSpreadPpm: 100_000 };

const str = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

/** Minimal EVM chain around @ethereumjs/vm: deploy, call, read, with an explicit clock. Every call is recorded. */
class EvmChain {
  private constructor(
    private readonly vm: Awaited<ReturnType<typeof createVM>>,
    private readonly common: Common,
  ) {}
  now = Math.floor(Date.now() / 1000);
  height = 1n;
  calls: SimEvmCall[] = [];
  names = new Map<string, 'HermesHTLC' | 'MockUSDC'>();
  static async create() {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    return new EvmChain(await createVM({ common }), common);
  }
  drain() {
    const c = this.calls;
    this.calls = [];
    return c;
  }
  private block() {
    return createBlock({ header: { timestamp: BigInt(this.now), number: this.height++, gasLimit: 30_000_000n } }, { common: this.common });
  }
  async deploy(bytecode: Hex, from: Hex, name: 'HermesHTLC' | 'MockUSDC'): Promise<Hex> {
    const r = await this.vm.evm.runCall({ caller: createAddressFromString(from), data: hexToBytes(bytecode), gasLimit: 10_000_000n, block: this.block() });
    if (r.execResult.exceptionError || !r.createdAddress) throw new Error(`deploy failed: ${r.execResult.exceptionError?.error}`);
    const addr = r.createdAddress.toString() as Hex;
    this.names.set(addr.toLowerCase(), name);
    this.calls.push({ from, to: addr, contract: name, fn: 'constructor (deploy)', args: [], calldata: `${bytecode.slice(0, 66)}… (${(bytecode.length - 2) / 2} bytes)`, ok: true, gas: r.execResult.executionGasUsed.toString(), blockTimestamp: this.now, logs: [] });
    return addr;
  }
  /** State-changing call. Returns gas and decoded logs, or the decoded custom error on revert. */
  async send(from: Hex, to: Hex, abi: Abi, functionName: string, args: readonly unknown[]) {
    const calldata = encodeFunctionData({ abi, functionName, args } as never);
    const r = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(calldata),
      gasLimit: 5_000_000n,
      block: this.block(),
    });
    const gas = r.execResult.executionGasUsed;
    const rec: SimEvmCall = { from, to, contract: this.names.get(to.toLowerCase()) ?? 'HermesHTLC', fn: functionName, args: args.map(str), calldata, ok: !r.execResult.exceptionError, gas: gas.toString(), blockTimestamp: this.now, logs: [] };
    this.calls.push(rec);
    if (r.execResult.exceptionError) {
      let reason = r.execResult.exceptionError.error as string;
      try {
        reason = decodeErrorResult({ abi, data: bytesToHex(r.execResult.returnValue) as Hex }).errorName;
      } catch {
        /* not a custom error */
      }
      rec.revert = reason;
      return { ok: false as const, reason, gas, logs: [] as { eventName: string; args: Record<string, unknown> }[] };
    }
    const logs = r.execResult.logs!.flatMap(([, topics, data]) => {
      try {
        return [decodeEventLog({ abi, topics: topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]], data: bytesToHex(data) as Hex }) as unknown as { eventName: string; args: Record<string, unknown> }];
      } catch {
        return [];
      }
    });
    rec.logs = logs.map((l) => ({ event: l.eventName, args: Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, str(v)])) }));
    return { ok: true as const, gas, logs };
  }
  async read<T>(to: Hex, abi: Abi, functionName: string, args: readonly unknown[]): Promise<T> {
    const r = await this.vm.evm.runCall({ to: createAddressFromString(to), data: hexToBytes(encodeFunctionData({ abi, functionName, args } as never)), gasLimit: 1_000_000n, block: this.block() });
    if (r.execResult.exceptionError) throw new Error(`read ${functionName} reverted`);
    return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) as Hex } as never) as T;
  }
}

function bchRecord(hex: string, accepted: boolean, txid?: string, error?: string): SimBchTx {
  const s = bchTxSummary(hex);
  return { txid, hex, accepted, bytes: hex.length / 2, ...s, ...(error ? { error } : {}) };
}

/** Raw transactions as broadcast, so the counterparty can read the secret from the claim. */
class RecordingProvider extends MockNetworkProvider {
  readonly raw = new Map<string, string>();
  pending: SimBchTx[] = [];
  override async sendRawTransaction(hex: string) {
    const txid = await super.sendRawTransaction(hex);
    this.raw.set(txid, hex);
    this.pending.push(bchRecord(hex, true, txid));
    return txid;
  }
  drain() {
    const p = this.pending;
    this.pending = [];
    return p;
  }
}

const fmt = (v: bigint, dec: number) => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(dec + 1, '0');
  return `${neg ? '−' : ''}${s.slice(0, -dec)}.${s.slice(-dec)}`;
};
export const formatSim = { usdc: (v: bigint) => `${fmt(v, USDC_DEC)} USDC`, pusd: (v: bigint) => `${fmt(v, PUSD_DEC)} tPUSD` };

/** Parse a decimal string ("12.5") into base units; undefined when invalid. */
export function parseSimAmount(s: string, decimals: number): bigint | undefined {
  const m = s.trim().match(/^(\d{1,12})(?:\.(\d*))?$/);
  if (!m || (m[2] ?? '').length > decimals) return undefined;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

/** Check the simulator inputs; returns a list of problems (empty = runnable). */
export function validateSimInput(o: { direction: Direction; scenario?: SimScenario; amount?: bigint; spreadPpm?: number }): string[] {
  const usdcIn = o.direction === 'usdc-to-pusd';
  const errors: string[] = [];
  const amountIn = o.amount ?? (usdcIn ? 5_000_000n : 500n);
  const spread = o.spreadPpm ?? 5000;
  if (!Number.isInteger(spread) || spread < 0 || spread > SIM_LIMITS.maxSpreadPpm) errors.push(`spread must be between 0% and ${SIM_LIMITS.maxSpreadPpm / 1e4}%`);
  const max = usdcIn ? SIM_LIMITS.maxUsdc : SIM_LIMITS.maxPusd;
  if (amountIn <= 0n) errors.push('amount must be positive');
  else if (amountIn > max) errors.push(`amount above the simulator's ${usdcIn ? formatSim.usdc(max) : formatSim.pusd(max)} limit`);
  else if (errors.length === 0) {
    const out = usdcIn ? convert(amountIn, USDC_DEC, PUSD_DEC, BigInt(1_000_000 - spread)) : convert(amountIn, PUSD_DEC, USDC_DEC, BigInt(1_000_000 - spread));
    const minOut = o.scenario === 'short-amount' ? 2n : 1n;
    if (out < minOut) errors.push(`amount too small: it converts to ${usdcIn ? formatSim.pusd(out) : formatSim.usdc(out)} after the spread`);
  }
  return errors;
}

const shortH = (h: string) => `${h.replace(/^0x/, '').slice(0, 12)}…`;

/**
 * Run one swap end to end. `amount` is in the input token's base units (USDC: 6 decimals; tPUSD: 2).
 * `onStep` streams progress (for the UI); when it returns a promise, the simulation waits for it
 * (step-through mode). `onPlan` receives the agreed terms before step 1. The full transcript is
 * also returned.
 */
export async function runSwapSimulation(opts: {
  direction: Direction;
  scenario?: SimScenario;
  amount?: bigint;
  spreadPpm?: number;
  /** May return a promise: the simulation waits for it (step-through mode). Other return values are ignored. */
  onStep?: (step: SimStep, balances: SimBalances) => unknown;
  onPlan?: (plan: SimPlan) => void;
}): Promise<SimResult> {
  const direction = opts.direction;
  const scenario = opts.scenario ?? 'happy';
  const attack: SimAttack | undefined = scenario === 'happy' || scenario === 'refund' ? undefined : scenario;
  const usdcIn = direction === 'usdc-to-pusd';
  const inputErrors = validateSimInput(opts);
  if (inputErrors.length) throw new Error(inputErrors.join('; '));
  const amountIn = opts.amount ?? (usdcIn ? 5_000_000n : 500n);
  const spreadPpm = opts.spreadPpm ?? 5000;
  const ratePpm = BigInt(1_000_000 - spreadPpm);
  const amountOut = usdcIn ? convert(amountIn, USDC_DEC, PUSD_DEC, ratePpm) : convert(amountIn, PUSD_DEC, USDC_DEC, ratePpm);
  const fIn = usdcIn ? formatSim.usdc : formatSim.pusd;
  const fOut = usdcIn ? formatSim.pusd : formatSim.usdc;

  // ── Parties ─────────────────────────────────────────────────────────────────────────────
  const evm = await EvmChain.create();
  const TAKER_EVM = '0x00000000000000000000000000000000000a11ce' as Hex;
  const SOLVER_EVM = '0x00000000000000000000000000000000000b0b00' as Hex;
  const DEPLOYER = '0x00000000000000000000000000000000000de910' as Hex;
  const bch = new RecordingProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
  const takerBch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const solverBch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const TPUSD = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

  const usdc = await evm.deploy(mockUsdcBytecode as Hex, DEPLOYER, 'MockUSDC');
  const htlc = await evm.deploy(hermesHtlcBytecode as Hex, DEPLOYER, 'HermesHTLC');
  for (const who of [TAKER_EVM, SOLVER_EVM]) await evm.send(DEPLOYER, usdc, mockUsdcAbi as Abi, 'mint', [who, FUND_USDC]);
  for (const w of [takerBch, solverBch]) {
    bch.addUtxo(w.address, randomUtxo({ satoshis: 200_000n }));
    bch.addUtxo(w.tokenAddress, randomUtxo({ satoshis: 1_000n, token: { category: TPUSD, amount: FUND_PUSD } }));
  }
  const setup = { evm: evm.drain(), bch: bch.drain() };

  const usdcOf = (a: Hex) => evm.read<bigint>(usdc, mockUsdcAbi as Abi, 'balanceOf', [a]);
  const pusdOf = async (addr: string) => (await bch.getUtxos(addr)).reduce((n, u) => n + (u.token?.category === TPUSD ? u.token.amount : 0n), 0n);
  const htlcAddrs = new Set<string>();
  const balances = async (): Promise<SimBalances> => {
    let escrowPusd = 0n;
    for (const a of htlcAddrs) escrowPusd += await pusdOf(a);
    return {
      taker: { usdc: await usdcOf(TAKER_EVM), pusd: await pusdOf(takerBch.tokenAddress) },
      solver: { usdc: await usdcOf(SOLVER_EVM), pusd: await pusdOf(solverBch.tokenAddress) },
      escrow: { usdc: await usdcOf(htlc), pusd: escrowPusd },
    };
  };
  const start = await balances();

  const steps: SimStep[] = [];
  const step = async (s: Omit<SimStep, 'n' | 'at'>) => {
    const evmCalls = evm.drain();
    const bchTxs = bch.drain();
    const full: SimStep = { ...s, n: steps.length + 1, at: evm.now, ...(evmCalls.length ? { evm: evmCalls } : {}), ...(bchTxs.length ? { bch: bchTxs } : {}) };
    steps.push(full);
    await opts.onStep?.(full, await balances());
    return full;
  };

  // ── Agreement ───────────────────────────────────────────────────────────────────────────
  const { secret, hashlock } = generateSecret();
  const t0 = evm.now;
  const tFirst = t0 + T_FIRST;
  const tSecond = t0 + T_SECOND;
  const timeoutErrors = validateTimeouts(tFirst, tSecond, t0);
  const plan: SimPlan = {
    direction,
    scenario,
    amountIn,
    amountOut,
    spreadPpm,
    decimalsIn: usdcIn ? USDC_DEC : PUSD_DEC,
    decimalsOut: usdcIn ? PUSD_DEC : USDC_DEC,
    symbolIn: usdcIn ? 'USDC' : 'tPUSD',
    symbolOut: usdcIn ? 'tPUSD' : 'USDC',
    t0,
    tFirst,
    tSecond,
    marginSeconds: SAFETY_MARGIN_SECONDS,
    hashlock,
    fee: feeBreakdown({ amountIn, amountOut, decimalsIn: usdcIn ? USDC_DEC : PUSD_DEC, decimalsOut: usdcIn ? PUSD_DEC : USDC_DEC }),
    contracts: { evmHtlc: htlc, evmUsdc: usdc, bchTokenCategory: TPUSD },
    parties: { takerEvm: TAKER_EVM, solverEvm: SOLVER_EVM, takerBch: takerBch.tokenAddress, solverBch: solverBch.tokenAddress },
  };
  opts.onPlan?.(plan);
  await step({
    chain: 'off-chain',
    actor: '—',
    title: 'Quote agreed over Nostr',
    detail: `${fIn(amountIn)} → ${fOut(amountOut)} (spread ${(spreadPpm / 1e4).toFixed(2)}%). Taker's lock T₁ = +3 h, solver's lock T₂ = +1 h: the side that locks first gets the longer timeout (T₁ ≥ T₂ + 1 h safety margin${timeoutErrors.length ? ` — VIOLATED: ${timeoutErrors.join('; ')}` : ' ✓'}).`,
    explain:
      'The taker asked for a price on Nostr and a solver answered with a signed quote: how much it will lock on the other chain, and two deadlines. The taker locks first, so its lock must outlive the solver’s by a safety margin — otherwise the solver could wait for the secret and still refund its own side.',
    expect: 'ok',
    ok: timeoutErrors.length === 0,
  });
  await step({
    chain: 'off-chain',
    actor: 'taker',
    title: 'Taker draws a 32-byte secret',
    detail: `hashlock = SHA-256(secret) = ${hashlock.slice(0, 16)}… — the same function on both chains. Only the hashlock is shared; the secret stays with the taker.`,
    explain: 'Both locks will be opened by the same secret. Whoever learns it can claim, so the taker keeps it private until it is sure the solver’s lock is exactly what was promised.',
    expect: 'ok',
    ok: true,
  });

  // ── Helpers per leg ─────────────────────────────────────────────────────────────────────
  let evmLockId: Hex | undefined;
  const evmLock = async (from: Hex, to: Hex, amount: bigint, timeout: number, actor: SimActor, lockHash = hashlock, label = actor === 'taker' ? 'T₁' : 'T₂') => {
    const a = await evm.send(from, usdc, mockUsdcAbi as Abi, 'approve', [htlc, amount]);
    const r = await evm.send(from, htlc, hermesHtlcAbi as Abi, 'lock', [usdc, amount, to, `0x${lockHash}`, BigInt(timeout)]);
    const ev = r.logs.find((l) => l.eventName === 'Locked');
    evmLockId = ev?.args.id as Hex | undefined;
    return { id: evmLockId, ok: r.ok && !!evmLockId, gas: a.gas + r.gas, label };
  };
  const bchContract = (recipientPkh: string, refundPkh: string, timeout: number, lockHash = hashlock) => htlcContract({ recipientPkh, refundPkh, hashlock: lockHash, timeout }, bch);
  const bchLock = async (locker: typeof takerBch, recipientPkh: string, amount: bigint, timeout: number, actor: SimActor, lockHash = hashlock) => {
    const c = bchContract(recipientPkh, locker.pkh, timeout, lockHash);
    htlcAddrs.add(c.tokenAddress);
    const utxos = [...(await bch.getUtxos(locker.address)), ...(await bch.getUtxos(locker.tokenAddress))] as never[];
    const tx = await buildLock({ provider: bch, contract: c, from: locker.address, utxos, token: { category: TPUSD, amount }, signer: locker.signer }).send();
    return { c, tx };
  };
  const htlcUtxo = async (c: ReturnType<typeof bchContract>) => (await bch.getUtxos(c.tokenAddress)).find((u) => u.token?.category === TPUSD) as never;
  const tryBch = async (f: () => TransactionBuilder) => {
    let hex: string | undefined;
    try {
      const b = f();
      try {
        hex = b.build();
      } catch {
        /* the builder may refuse before signing; the VM error below is what matters */
      }
      const t = await b.send();
      return { ok: true as const, txid: t.txid, hex: t.hex };
    } catch (e) {
      const reason = ((e as Error).message.match(/(Failing statement|Error in transaction|required|failed)[^\n]*/i)?.[0] ?? (e as Error).message).slice(0, 140);
      if (hex) bch.pending.push(bchRecord(hex, false, undefined, reason));
      else bch.pending.push({ accepted: false, error: reason });
      return { ok: false as const, reason };
    }
  };
  const wrong = generateSecret().secret;

  const evmLockStep = (l: Awaited<ReturnType<typeof evmLock>>, actor: SimActor, amount: bigint, extra = '') =>
    step({
      chain: 'EVM',
      actor,
      title: `${actor === 'taker' ? 'Taker' : 'Solver'} locks ${formatSim.usdc(amount)} in HermesHTLC${extra}`,
      detail: `approve + lock(token, amount, recipient, hashlock, timeout = ${l.label}). The USDC now sits in the contract; only the secret (to the recipient) or the timeout (back to the sender) can move it.`,
      explain:
        actor === 'taker'
          ? 'The taker goes first: its USDC is locked under the hashlock until T₁. It cannot lose it — without the secret nobody can claim it, and after T₁ it comes back.'
          : 'The solver commits its side. Each parameter (hashlock, recipient, amount, timeout) is stored in the contract and can be read back by anyone.',
      expect: 'ok',
      ok: l.ok,
      ref: l.id,
      cost: `${l.gas.toLocaleString('en-US')} gas`,
    });
  const bchLockStep = (r: Awaited<ReturnType<typeof bchLock>>, actor: SimActor, amount: bigint, label: string, extra = '') =>
    step({
      chain: 'BCH',
      actor,
      title: `${actor === 'taker' ? 'Taker' : 'Solver'} locks ${formatSim.pusd(amount)} in the BCH HTLC covenant${extra}`,
      detail: `A CashToken output to the covenant address ${r.c.tokenAddress.slice(0, 22)}… whose script commits to (recipient, refund key, hashlock, ${label}).`,
      explain:
        actor === 'taker'
          ? 'The taker goes first: its tPUSD sits in a covenant whose address is the hash of its rules. Only the secret (to the solver) or T₁ (back to the taker) can spend it.'
          : 'The solver commits its side. The covenant address is derived from all four parameters, so a lock with different terms lands at a different address.',
      expect: 'ok',
      ok: true,
      ref: r.tx.txid,
      cost: `${r.tx.hex.length / 2} bytes`,
    });

  /** The parameters a malicious solver actually uses for its counter-lock. */
  const counterTerms = () => {
    const nowT = evm.now;
    return {
      hashlock: attack === 'bad-hashlock' ? generateSecret().hashlock : hashlock,
      timeout: attack === 'short-timeout' ? nowT + 600 : tSecond,
      amount: attack === 'short-amount' ? amountOut - (amountOut / 10n > 0n ? amountOut / 10n : 1n) : amountOut,
    };
  };
  const attackTitle = attack === 'bad-hashlock' ? ' — under a different hashlock' : attack === 'short-timeout' ? ' — expiring in 10 minutes' : attack === 'short-amount' ? ' — 10% short' : '';
  const verifyStep = async (chain: 'EVM' | 'BCH', seen: Parameters<typeof verifyCounterLock>[1], recipient: string, how: string) => {
    const v = verifyCounterLock({ hashlock, recipient, amountOut, tFirst, tSecond }, seen, evm.now);
    const failed = v.checks.filter((c) => !c.ok);
    await step({
      chain,
      actor: 'taker',
      title: v.ok ? 'Taker verifies the counter-lock' : 'Taker’s verification catches the bad counter-lock',
      detail: `${how} ${v.checks.map((c) => `${c.name} ${c.ok ? '✓' : '✗'}`).join(' · ')}${failed.length ? ` — ${failed.map((c) => c.detail).join('; ')}` : ''}.`,
      explain: v.ok
        ? 'Claiming reveals the secret, so before claiming the taker checks every term against the quote: the hashlock is its own, it is the recipient, the amount is at least what was quoted, and the timeout leaves time to claim with T₁ ≥ T₂ + margin.'
        : `This is the moment that protects the taker. Claiming would publish the secret, and the solver could then take the taker’s lock. One check failed (${failed.map((c) => c.name).join(', ')}), so the taker does not claim — it keeps the secret and simply waits out T₁.`,
      expect: attack ? 'rejected' : 'ok',
      ok: attack ? !v.ok : v.ok,
      checks: v.checks,
    });
    return v.ok;
  };
  const refuseStep = () =>
    step({
      chain: 'off-chain',
      actor: 'taker',
      title: 'Taker refuses to claim — the secret stays private',
      detail: 'No claim transaction is built or broadcast, so the secret never appears on either chain. The solver cannot open the taker’s lock without it.',
      explain: 'Refusing costs the taker nothing but time: its funds are still locked under its own hashlock and come back after T₁.',
      expect: 'ok',
      ok: true,
    });
  const secretStep = () => {
    const onBch = [...bch.raw.values()].some((h) => h.includes(secret));
    const onEvm = steps.some((s) => (s.evm ?? []).some((c) => c.calldata.includes(secret)));
    return step({
      chain: 'off-chain',
      actor: '—',
      title: 'The secret was never revealed',
      detail: `Scanned every broadcast BCH transaction and every EVM calldata of this run for the 32-byte secret: ${onBch || onEvm ? 'FOUND (!)' : 'not present ✓'}.`,
      explain: 'Because the taker refused, the hashlock was never opened anywhere: neither party could claim, and both locks can only go back to their owners.',
      expect: 'ok',
      ok: !onBch && !onEvm,
    });
  };

  // ── Scenario ────────────────────────────────────────────────────────────────────────────
  if (usdcIn) {
    // USDC → PUSD: taker locks USDC (EVM, T₁) → solver locks tPUSD (BCH, T₂) → taker claims tPUSD (reveals) → solver claims USDC.
    await evmLockStep(await evmLock(TAKER_EVM, SOLVER_EVM, amountIn, tFirst, 'taker'), 'taker', amountIn);
    const takerLockId = evmLockId;
    const lock = await evm.read<readonly [Hex, Hex, Hex, bigint, Hex, bigint, number]>(htlc, hermesHtlcAbi as Abi, 'locks', [takerLockId]);
    const verified = lock[1].toLowerCase() === SOLVER_EVM && lock[3] === amountIn && lock[4] === `0x${hashlock}` && Number(lock[5]) === tFirst && lock[6] === 1;
    await step({ chain: 'EVM', actor: 'solver', title: 'Solver verifies the lock on-chain', detail: `locks(id): recipient = solver, amount = ${formatSim.usdc(lock[3])}, hashlock matches, timeout = T₁, state = Locked ${verified ? '✓' : '✗'}. Only now does the solver commit its own funds.`, explain: 'The solver never trusts a message saying “I locked”; it reads the lock from the contract itself before risking anything.', expect: 'ok', ok: verified });

    if (scenario === 'refund') {
      await step({ chain: 'off-chain', actor: 'solver', title: 'Solver goes offline — never counter-locks', detail: 'The taker is left with a USDC lock and no tPUSD. Nothing can be lost: the contract returns the USDC after T₁.', explain: 'A solver can always walk away. The design makes that harmless: the worst case for the taker is waiting until T₁.', expect: 'ok', ok: true });
      const early = await evm.send(TAKER_EVM, htlc, hermesHtlcAbi as Abi, 'refund', [takerLockId]);
      await step({ chain: 'EVM', actor: 'taker', title: 'Refund before T₁ is refused', detail: `refund(id) at T₁ − 3 h → reverted with ${early.ok ? 'nothing (!)' : early.reason}.`, explain: 'The timeout cuts both ways: before T₁ the taker cannot pull its funds back, which is what lets the solver safely counter-lock.', expect: 'rejected', ok: !early.ok, cost: `${early.gas.toLocaleString('en-US')} gas` });
      const steal = await evm.send(SOLVER_EVM, htlc, hermesHtlcAbi as Abi, 'claim', [takerLockId, `0x${wrong}`]);
      await step({ chain: 'EVM', actor: 'attacker', title: 'Solver tries to claim with a guessed secret', detail: `claim(id, random 32 bytes) → reverted with ${steal.ok ? 'nothing (!)' : steal.reason}.`, explain: 'Only the preimage of the hashlock opens the lock; guessing 32 random bytes is hopeless.', expect: 'rejected', ok: !steal.ok });
      evm.now = tFirst + 1;
      const r = await evm.send(TAKER_EVM, htlc, hermesHtlcAbi as Abi, 'refund', [takerLockId]);
      await step({ chain: 'EVM', actor: 'taker', title: `After T₁: taker refunds ${formatSim.usdc(amountIn)}`, detail: `refund(id) → Refunded event. The taker has all its USDC back; the swap simply did not happen.`, explain: 'After T₁ the contract sends the USDC back to its sender — no one’s permission needed.', expect: 'ok', ok: r.ok && r.logs.some((l) => l.eventName === 'Refunded'), cost: `${r.gas.toLocaleString('en-US')} gas` });
    } else {
      evm.now += 60;
      const terms = counterTerms();
      const lockR = await bchLock(solverBch, takerBch.pkh, terms.amount, terms.timeout, 'solver', terms.hashlock);
      await bchLockStep(lockR, 'solver', terms.amount, attack === 'short-timeout' ? 'a 10-minute timeout' : 'T₂', attackTitle);
      // The solver announces its lock terms; the taker derives the covenant address from them itself and looks there.
      const derived = bchContract(takerBch.pkh, solverBch.pkh, terms.timeout, terms.hashlock);
      const found = (await bch.getUtxos(derived.tokenAddress)).find((u) => u.token?.category === TPUSD);
      const ok = await verifyStep(
        'BCH',
        { found: !!found, hashlock: terms.hashlock, recipient: takerBch.pkh, amount: found?.token?.amount, timeout: terms.timeout },
        takerBch.pkh,
        `Derived the covenant address from the announced terms and read its output (${found ? formatSim.pusd(found.token!.amount) : 'none'}):`,
      );
      const c = lockR.c;
      const u0 = await htlcUtxo(c);
      if (!ok) {
        await refuseStep();
        const steal = await evm.send(SOLVER_EVM, htlc, hermesHtlcAbi as Abi, 'claim', [takerLockId, `0x${wrong}`]);
        await step({ chain: 'EVM', actor: 'attacker', title: 'Solver tries to claim the taker’s USDC without the secret', detail: `claim(id, guessed preimage) → reverted with ${steal.ok ? 'nothing (!)' : steal.reason}.`, explain: 'With no secret published, the solver’s only way in is to guess — and the contract rejects it.', expect: 'rejected', ok: !steal.ok });
        const early = await evm.send(TAKER_EVM, htlc, hermesHtlcAbi as Abi, 'refund', [takerLockId]);
        await step({ chain: 'EVM', actor: 'taker', title: 'Refund before T₁ is refused', detail: `refund(id) before T₁ → reverted with ${early.ok ? 'nothing (!)' : early.reason}.`, explain: 'The taker has to wait for T₁ like everyone else: the timeout is enforced by the contract, not by goodwill.', expect: 'rejected', ok: !early.ok });
        evm.now = Math.max(evm.now, terms.timeout) + 1;
        const sr = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: terms.timeout, refunder: solverBch.signer, refundTokenAddr: solverBch.tokenAddress }));
        await step({ chain: 'BCH', actor: 'solver', title: `Solver takes back its bad lock (${formatSim.pusd(terms.amount)})`, detail: `After its own timeout the solver refunds the covenant → ${sr.ok ? 'accepted' : `rejected: ${sr.reason}`}.`, explain: 'The malicious lock gained the solver nothing: it only gets its own tPUSD back.', expect: 'ok', ok: sr.ok, ref: sr.ok ? sr.txid : undefined, cost: sr.ok ? `${sr.hex.length / 2} bytes` : undefined });
        evm.now = Math.max(evm.now, tFirst) + 1;
        const r = await evm.send(TAKER_EVM, htlc, hermesHtlcAbi as Abi, 'refund', [takerLockId]);
        await step({ chain: 'EVM', actor: 'taker', title: `After T₁: taker refunds ${formatSim.usdc(amountIn)}`, detail: 'refund(id) → Refunded event. The taker has all its USDC back.', explain: 'Because the taker verified before revealing, the attack ends with both parties exactly where they started.', expect: 'ok', ok: r.ok && r.logs.some((l) => l.eventName === 'Refunded'), cost: `${r.gas.toLocaleString('en-US')} gas` });
        await secretStep();
      } else {
        const wrongTry = await tryBch(() => buildClaim({ provider: bch, contract: c, utxo: u0, recipient: takerBch.signer, recipientTokenAddr: takerBch.tokenAddress, preimage: wrong }));
        await step({ chain: 'BCH', actor: 'attacker', title: 'Claim with a wrong secret is rejected by the covenant', detail: `The BCH VM evaluates the covenant: sha256(preimage) ≠ hashlock → ${wrongTry.ok ? 'ACCEPTED (!)' : 'transaction invalid'}.`, explain: 'The covenant hashes whatever preimage is offered and compares it with the hashlock it commits to.', expect: 'rejected', ok: !wrongTry.ok });
        const early = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: tSecond - 600, refunder: solverBch.signer, refundTokenAddr: solverBch.tokenAddress }));
        await step({ chain: 'BCH', actor: 'solver', title: 'Early refund of the tPUSD is rejected', detail: `A refund with locktime before T₂ fails the covenant's timeout check → ${early.ok ? 'ACCEPTED (!)' : 'transaction invalid'}.`, explain: 'The solver cannot yank its tPUSD back while the taker is still allowed to claim.', expect: 'rejected', ok: !early.ok });
        evm.now += 60;
        const claim = await tryBch(() => buildClaim({ provider: bch, contract: c, utxo: u0, recipient: takerBch.signer, recipientTokenAddr: takerBch.tokenAddress, preimage: secret }));
        await step({ chain: 'BCH', actor: 'taker', title: `Taker claims ${formatSim.pusd(amountOut)} — revealing the secret`, detail: 'The claim transaction carries the 32-byte secret in its unlocking bytecode; it is now public on BCH.', explain: 'The taker gets paid first, but doing so publishes the secret — which is exactly what the solver needs to get paid too.', expect: 'ok', ok: claim.ok, ref: claim.ok ? claim.txid : undefined, cost: claim.ok ? `${claim.hex.length / 2} bytes` : undefined });
        const learned = claim.ok ? extractPreimageFromBchTx(bch.raw.get(claim.txid)!, hashlock) : undefined;
        await step({ chain: 'off-chain', actor: 'solver', title: 'Solver reads the secret from the BCH claim', detail: learned ? `Decoded the claim's inputs, found the push whose SHA-256 is the hashlock: secret = ${learned.slice(0, 16)}…` : 'secret not found', explain: 'Anyone watching the BCH chain can read the secret from the claim’s unlocking bytecode. The solver has until T₁ to use it.', expect: 'ok', ok: learned === secret });
        evm.now += 60;
        const r = await evm.send(SOLVER_EVM, htlc, hermesHtlcAbi as Abi, 'claim', [takerLockId, `0x${learned ?? wrong}`]);
        await step({ chain: 'EVM', actor: 'solver', title: `Solver claims ${formatSim.usdc(amountIn)} with the same secret`, detail: 'claim(id, secret) → Claimed event. Both legs settled atomically: neither side could get paid without paying.', explain: 'Same secret, other chain: the second leg settles. That is the atomicity — both happen, or (with refunds) neither does.', expect: 'ok', ok: r.ok, ref: takerLockId, cost: `${r.gas.toLocaleString('en-US')} gas` });
        const replay = await evm.send(SOLVER_EVM, htlc, hermesHtlcAbi as Abi, 'claim', [takerLockId, `0x${secret}`]);
        await step({ chain: 'EVM', actor: 'attacker', title: 'Claiming the same lock twice is rejected', detail: `claim(id, secret) again → reverted with ${replay.ok ? 'nothing (!)' : replay.reason}.`, explain: 'Once claimed, a lock is closed for good; a replay gets nothing.', expect: 'rejected', ok: !replay.ok });
      }
    }
  } else {
    // PUSD → USDC: taker locks tPUSD (BCH, T₁) → solver locks USDC (EVM, T₂) → taker claims USDC (reveals in calldata/event) → solver claims tPUSD.
    const tl = await bchLock(takerBch, solverBch.pkh, amountIn, tFirst, 'taker');
    await bchLockStep(tl, 'taker', amountIn, 'T₁');
    const c = tl.c;
    const u0 = await htlcUtxo(c);
    await step({ chain: 'BCH', actor: 'solver', title: 'Solver verifies the lock on-chain', detail: `It derives the covenant address from (solver, taker, hashlock, T₁) itself and finds ${formatSim.pusd(u0 ? (u0 as { token: { amount: bigint } }).token.amount : 0n)} there ✓ — an output elsewhere would not count.`, explain: 'The solver never trusts a message saying “I locked”; it computes where a correct lock must be and checks the chain.', expect: 'ok', ok: !!u0 });
    if (scenario === 'refund') {
      await step({ chain: 'off-chain', actor: 'solver', title: 'Solver goes offline — never counter-locks', detail: 'The taker is left with a tPUSD lock. The covenant returns it after T₁.', explain: 'A solver can always walk away. The design makes that harmless: the worst case for the taker is waiting until T₁.', expect: 'ok', ok: true });
      const early = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: tFirst - 3600, refunder: takerBch.signer, refundTokenAddr: takerBch.tokenAddress }));
      await step({ chain: 'BCH', actor: 'taker', title: 'Refund before T₁ is refused', detail: `locktime < T₁ fails the covenant's timeout check → ${early.ok ? 'ACCEPTED (!)' : 'transaction invalid'}.`, explain: 'Before T₁ the covenant will not release the tPUSD to the taker, which is what lets a solver safely counter-lock.', expect: 'rejected', ok: !early.ok });
      const steal = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: tFirst, refunder: solverBch.signer, refundTokenAddr: solverBch.tokenAddress }));
      await step({ chain: 'BCH', actor: 'attacker', title: 'Someone else tries the refund path', detail: `Refund signed by the solver's key → ${steal.ok ? 'ACCEPTED (!)' : 'transaction invalid'}: only the refund key in the covenant can take it back.`, explain: 'The refund path checks a signature against the refund key committed in the covenant.', expect: 'rejected', ok: !steal.ok });
      evm.now = tFirst + 1;
      const r = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: tFirst, refunder: takerBch.signer, refundTokenAddr: takerBch.tokenAddress }));
      await step({ chain: 'BCH', actor: 'taker', title: `After T₁: taker refunds ${formatSim.pusd(amountIn)}`, detail: 'Refund with nLockTime = T₁ (CHECKLOCKTIMEVERIFY) signed by the taker → accepted. Funds are back.', explain: 'After T₁ the taker’s own signature is enough to take the tPUSD back.', expect: 'ok', ok: r.ok, ref: r.ok ? r.txid : undefined, cost: r.ok ? `${r.hex.length / 2} bytes` : undefined });
    } else {
      evm.now += 60;
      const terms = counterTerms();
      const sl = await evmLock(SOLVER_EVM, TAKER_EVM, terms.amount, terms.timeout, 'solver', terms.hashlock, attack === 'short-timeout' ? 'now + 10 min' : 'T₂');
      await evmLockStep(sl, 'solver', terms.amount, attackTitle);
      const solverLockId = evmLockId;
      // The taker reads the lock's terms from the contract itself.
      const l = await evm.read<readonly [Hex, Hex, Hex, bigint, Hex, bigint, number]>(htlc, hermesHtlcAbi as Abi, 'locks', [solverLockId]);
      const ok = await verifyStep(
        'EVM',
        { found: l[6] === 1, hashlock: l[4], recipient: l[1].toLowerCase(), amount: l[3], timeout: Number(l[5]) },
        TAKER_EVM,
        `Read locks(id) from HermesHTLC: hashlock ${shortH(l[4])}, amount ${formatSim.usdc(l[3])}, timeout +${Math.round((Number(l[5]) - evm.now) / 60)} min:`,
      );
      if (!ok) {
        await refuseStep();
        const steal = await tryBch(() => buildClaim({ provider: bch, contract: c, utxo: u0, recipient: solverBch.signer, recipientTokenAddr: solverBch.tokenAddress, preimage: wrong }));
        await step({ chain: 'BCH', actor: 'attacker', title: 'Solver tries to claim the taker’s tPUSD without the secret', detail: `Claim with a guessed preimage → ${steal.ok ? 'ACCEPTED (!)' : 'transaction invalid'}.`, explain: 'With no secret published, the solver’s only way in is to guess — and the covenant rejects it.', expect: 'rejected', ok: !steal.ok });
        const early = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: tFirst - 3600, refunder: takerBch.signer, refundTokenAddr: takerBch.tokenAddress }));
        await step({ chain: 'BCH', actor: 'taker', title: 'Refund before T₁ is refused', detail: `locktime < T₁ fails the covenant's timeout check → ${early.ok ? 'ACCEPTED (!)' : 'transaction invalid'}.`, explain: 'The taker has to wait for T₁ like everyone else: the timeout is enforced by the covenant, not by goodwill.', expect: 'rejected', ok: !early.ok });
        evm.now = Math.max(evm.now, terms.timeout) + 1;
        const sr = await evm.send(SOLVER_EVM, htlc, hermesHtlcAbi as Abi, 'refund', [solverLockId]);
        await step({ chain: 'EVM', actor: 'solver', title: `Solver takes back its bad lock (${formatSim.usdc(terms.amount)})`, detail: `refund(id) after its own timeout → ${sr.ok ? 'Refunded event' : `reverted with ${sr.reason}`}.`, explain: 'The malicious lock gained the solver nothing: it only gets its own USDC back.', expect: 'ok', ok: sr.ok, ref: solverLockId, cost: `${sr.gas.toLocaleString('en-US')} gas` });
        evm.now = Math.max(evm.now, tFirst) + 1;
        const r = await tryBch(() => buildRefund({ provider: bch, contract: c, utxo: u0, timeout: tFirst, refunder: takerBch.signer, refundTokenAddr: takerBch.tokenAddress }));
        await step({ chain: 'BCH', actor: 'taker', title: `After T₁: taker refunds ${formatSim.pusd(amountIn)}`, detail: 'Refund with nLockTime = T₁ signed by the taker → accepted. Funds are back.', explain: 'Because the taker verified before revealing, the attack ends with both parties exactly where they started.', expect: 'ok', ok: r.ok, ref: r.ok ? r.txid : undefined, cost: r.ok ? `${r.hex.length / 2} bytes` : undefined });
        await secretStep();
      } else {
        const bad = await evm.send(TAKER_EVM, htlc, hermesHtlcAbi as Abi, 'claim', [solverLockId, `0x${wrong}`]);
        await step({ chain: 'EVM', actor: 'attacker', title: 'Claim with a wrong secret is rejected by HermesHTLC', detail: `claim(id, random 32 bytes) → reverted with ${bad.ok ? 'nothing (!)' : bad.reason}.`, explain: 'HermesHTLC hashes the offered preimage with SHA-256 and compares it with the stored hashlock.', expect: 'rejected', ok: !bad.ok });
        const early = await evm.send(SOLVER_EVM, htlc, hermesHtlcAbi as Abi, 'refund', [solverLockId]);
        await step({ chain: 'EVM', actor: 'solver', title: 'Early refund of the USDC is rejected', detail: `refund(id) before T₂ → reverted with ${early.ok ? 'nothing (!)' : early.reason}.`, explain: 'The solver cannot yank its USDC back while the taker is still allowed to claim.', expect: 'rejected', ok: !early.ok });
        evm.now += 60;
        const r = await evm.send(TAKER_EVM, htlc, hermesHtlcAbi as Abi, 'claim', [solverLockId, `0x${secret}`]);
        const claimed = r.logs.find((x) => x.eventName === 'Claimed');
        await step({ chain: 'EVM', actor: 'taker', title: `Taker claims ${formatSim.usdc(amountOut)} — revealing the secret`, detail: 'claim(id, secret) → the Claimed(id, preimage) event publishes the secret on the EVM chain.', explain: 'The taker gets paid first, but doing so publishes the secret — which is exactly what the solver needs to get paid too.', expect: 'ok', ok: r.ok && !!claimed, ref: solverLockId, cost: `${r.gas.toLocaleString('en-US')} gas` });
        const learned = (claimed?.args.preimage as string | undefined)?.slice(2);
        await step({ chain: 'off-chain', actor: 'solver', title: 'Solver reads the secret from the Claimed event', detail: learned ? `preimage = ${learned.slice(0, 16)}… (SHA-256 matches the hashlock)` : 'event missing', explain: 'The Claimed event (and the calldata) carry the secret in the clear. The solver has until T₁ to use it on BCH.', expect: 'ok', ok: learned === secret });
        evm.now += 60;
        const claim = await tryBch(() => buildClaim({ provider: bch, contract: c, utxo: u0, recipient: solverBch.signer, recipientTokenAddr: solverBch.tokenAddress, preimage: learned ?? wrong }));
        await step({ chain: 'BCH', actor: 'solver', title: `Solver claims ${formatSim.pusd(amountIn)} with the same secret`, detail: 'The covenant checks sha256(preimage) = hashlock and the recipient key → accepted. Both legs settled.', explain: 'Same secret, other chain: the second leg settles. That is the atomicity — both happen, or (with refunds) neither does.', expect: 'ok', ok: claim.ok, ref: claim.ok ? claim.txid : undefined, cost: claim.ok ? `${claim.hex.length / 2} bytes` : undefined });
      }
    }
  }

  const end = await balances();
  // Sanity: whatever happened, value is conserved across parties + escrow.
  const total = (b: SimBalances) => [b.taker.usdc + b.solver.usdc + b.escrow.usdc, b.taker.pusd + b.solver.pusd + b.escrow.pusd];
  const [tu0, p0] = total(start);
  const [tu1, p1] = total(end);
  await step({
    chain: 'off-chain',
    actor: '—',
    title: 'Conservation check',
    detail: `USDC total ${formatSim.usdc(tu0!)} → ${formatSim.usdc(tu1!)}; tPUSD total ${formatSim.pusd(p0!)} → ${formatSim.pusd(p1!)}; escrow left: ${formatSim.usdc(end.escrow.usdc)}, ${formatSim.pusd(end.escrow.pusd)}.`,
    explain: 'Nothing was created or destroyed: every token is with the taker, the solver, or back from escrow. A swap either settles both sides or refunds both.',
    expect: 'ok',
    ok: tu0 === tu1 && p0 === p1 && end.escrow.usdc === 0n && end.escrow.pusd === 0n,
  });
  return { direction, scenario, steps, balances: end, start, secret, hashlock, passed: steps.every((s) => s.ok), plan, setup };
}

/** Decode a BCH tx for display (input/output counts). */
export function bchTxSummary(hex: string) {
  const tx = decodeTransaction(hexToBin(hex));
  return typeof tx === 'string' ? undefined : { inputs: tx.inputs.length, outputs: tx.outputs.length, locktime: tx.locktime };
}

/** JSON-ready transcript of a run (bigints as decimal strings), for download. */
export function simTranscript(r: SimResult, generatedAt = new Date().toISOString()) {
  const b = (x: SimBalances) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return {
    kind: 'hermes-swap-simulation',
    version: 1,
    generatedAt,
    note: 'In-browser simulation: real HermesHTLC/MockUSDC bytecode on @ethereumjs/vm and the real HermesHtlc covenant on the BCH 2026 VM (CashScript MockNetworkProvider). Nothing was broadcast to any network.',
    direction: r.direction,
    scenario: r.scenario,
    passed: r.passed,
    secret: r.secret,
    hashlock: r.hashlock,
    plan: JSON.parse(JSON.stringify(r.plan, (_, v) => (typeof v === 'bigint' ? v.toString() : v))),
    actionMarginSeconds: ACTION_MARGIN_SECONDS,
    balances: { start: b(r.start), end: b(r.balances) },
    setup: r.setup,
    steps: r.steps.map((s) => ({ ...s, atIso: new Date(s.at * 1000).toISOString() })),
  };
}
