import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { hermesHtlcAbi } from '../../evm-htlc/abi.js';
import networks from '../../../config/networks.json' with { type: 'json' };

export { hermesHtlcAbi };
export const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

export type EvmKey = keyof typeof networks.evm;

export interface EvmChainConfig {
  chainId: number;
  name: string;
  rpc: string;
  explorerTx: string;
  usdc: string | null;
  htlc: string | null;
  confirmations: number;
}

export const evmConfig = (key: EvmKey) => networks.evm[key] as EvmChainConfig;

export function evmChain(cfg: EvmChainConfig) {
  return {
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  } as const;
}

export function publicClientFor(cfg: EvmChainConfig): PublicClient {
  return createPublicClient({ chain: evmChain(cfg), transport: http(cfg.rpc) }) as PublicClient;
}

/** Decimals are always read from the token contract, never assumed (invariant 6). */
export async function tokenDecimals(client: PublicClient, token: Address): Promise<number> {
  return Number(await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }));
}

export interface EvmLock {
  id: Hex;
  sender: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  hashlock: Hex;
  timeout: bigint;
  state: 'none' | 'locked' | 'claimed' | 'refunded';
}

const STATES = ['none', 'locked', 'claimed', 'refunded'] as const;

export async function readLock(client: PublicClient, htlc: Address, id: Hex): Promise<EvmLock> {
  const r = (await client.readContract({ address: htlc, abi: hermesHtlcAbi, functionName: 'locks', args: [id] })) as readonly [
    Address,
    Address,
    Address,
    bigint,
    Hex,
    bigint,
    number,
  ];
  return { id, sender: r[0], recipient: r[1], token: r[2], amount: r[3], hashlock: r[4], timeout: r[5], state: STATES[r[6]] };
}

/** Approve (if needed) and lock tokens. Returns the lock id from the Locked event. */
export async function evmLock(args: {
  wallet: WalletClient;
  client: PublicClient;
  htlc: Address;
  token: Address;
  amount: bigint;
  recipient: Address;
  hashlock: Hex;
  timeout: bigint;
}): Promise<{ id: Hex; txHash: Hex }> {
  const account = args.wallet.account!;
  const allowance = await args.client.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, args.htlc],
  });
  if (allowance < args.amount) {
    const h = await args.wallet.writeContract({
      address: args.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [args.htlc, args.amount],
      account,
      chain: args.wallet.chain,
    });
    await args.client.waitForTransactionReceipt({ hash: h });
  }
  const txHash = await args.wallet.writeContract({
    address: args.htlc,
    abi: hermesHtlcAbi,
    functionName: 'lock',
    args: [args.token, args.amount, args.recipient, args.hashlock, args.timeout],
    account,
    chain: args.wallet.chain,
  });
  const receipt = await args.client.waitForTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: hermesHtlcAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'Locked') return { id: (ev.args as { id: Hex }).id, txHash };
    } catch {
      /* other logs */
    }
  }
  throw new Error('Locked event not found');
}

export async function evmClaim(args: { wallet: WalletClient; client: PublicClient; htlc: Address; id: Hex; preimage: Hex }) {
  const hash = await args.wallet.writeContract({
    address: args.htlc,
    abi: hermesHtlcAbi,
    functionName: 'claim',
    args: [args.id, args.preimage],
    account: args.wallet.account!,
    chain: args.wallet.chain,
  });
  await args.client.waitForTransactionReceipt({ hash });
  return hash;
}

export async function evmRefund(args: { wallet: WalletClient; client: PublicClient; htlc: Address; id: Hex }) {
  const hash = await args.wallet.writeContract({
    address: args.htlc,
    abi: hermesHtlcAbi,
    functionName: 'refund',
    args: [args.id],
    account: args.wallet.account!,
    chain: args.wallet.chain,
  });
  await args.client.waitForTransactionReceipt({ hash });
  return hash;
}

/** Find the secret revealed by an EVM claim (Claimed event). */
export async function findEvmPreimage(client: PublicClient, htlc: Address, id: Hex, fromBlock?: bigint): Promise<Hex | undefined> {
  const logs = await client.getContractEvents({
    address: htlc,
    abi: hermesHtlcAbi,
    eventName: 'Claimed',
    args: { id },
    fromBlock: fromBlock ?? 'earliest',
  });
  const first = logs[0] as unknown as { args: { preimage: Hex } } | undefined;
  return first?.args.preimage;
}

export interface EvmLockEvent {
  id: Hex;
  sender: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  hashlock: Hex;
  timeout: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

export async function findEvmLocks(client: PublicClient, htlc: Address, opts: { recipient?: Address; fromBlock?: bigint }): Promise<EvmLockEvent[]> {
  const logs = await client.getContractEvents({
    address: htlc,
    abi: hermesHtlcAbi,
    eventName: 'Locked',
    args: opts.recipient ? { recipient: opts.recipient } : undefined,
    fromBlock: opts.fromBlock ?? 'earliest',
  });
  return logs.map((l) => {
    const a = (l as unknown as { args: Omit<EvmLockEvent, 'blockNumber' | 'txHash'> }).args;
    return { ...a, blockNumber: l.blockNumber as bigint, txHash: l.transactionHash as Hex };
  });
}
