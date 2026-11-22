import { readFileSync, writeFileSync } from 'node:fs';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { promptSecret } from '@hermes/chain/prompt';
import { evmChain, evmConfig, publicClientFor, type EvmChainConfig, type EvmKey } from '@hermes/swap';
import { hermesHtlcAbi, hermesHtlcBytecode, mockUsdcAbi, mockUsdcBytecode } from '../../../packages/evm-htlc/abi.js';
import { flag, opt } from './args.js';

const CONFIG = new URL('../../../config/networks.json', import.meta.url);

/**
 * hermes evm deploy --evm baseSepolia [--mock-usdc]
 * Deploys HermesHTLC (and optionally a mock 6-decimal token for local/testnet demos) and records
 * the addresses in config/networks.json. Mainnet EVM ("base") needs owner approval.
 */
export async function deployHermesHtlc(args: { privateKey: Hex; cfg: EvmChainConfig; mockUsdc: boolean }) {
  const { cfg } = args;
  const account = privateKeyToAccount(args.privateKey);
  const wallet = createWalletClient({ account, chain: evmChain(cfg), transport: http(cfg.rpc) });
  const client = publicClientFor(cfg);
  const deploy = async (abi: readonly unknown[], bytecode: string) => {
    const hash = await wallet.deployContract({ abi, bytecode: bytecode as Hex, account, chain: wallet.chain } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress as Address, hash };
  };
  const htlc = await deploy(hermesHtlcAbi, hermesHtlcBytecode);
  const usdc = args.mockUsdc ? await deploy(mockUsdcAbi, mockUsdcBytecode) : undefined;
  return { htlc, usdc };
}

/** Record deployed addresses in a networks.json file (non-secret). */
export function recordEvmDeployment(configFile: URL | string, key: string, htlc: Address, usdc?: Address) {
  const json = JSON.parse(readFileSync(configFile, 'utf8'));
  json.evm[key].htlc = htlc;
  if (usdc) {
    json.evm[key].usdc = usdc;
    json.evm[key].usdcSource = 'Hermes MockUSDC (demo only)';
  }
  writeFileSync(configFile, JSON.stringify(json, null, 2) + '\n');
}

export async function evmDeploy() {
  const key = opt('evm', 'baseSepolia') as EvmKey;
  if (key === 'base' && !flag('i-have-owner-approval')) throw new Error('EVM mainnet deploy needs the owner’s explicit approval (CLAUDE.md).');
  const cfg = evmConfig(key);
  const privateKey = (await promptSecret(`Deployer key for ${cfg.name} (0x…): `)) as Hex;
  const { htlc, usdc } = await deployHermesHtlc({ privateKey, cfg, mockUsdc: flag('mock-usdc') });
  console.log(`HermesHTLC ${htlc.address}${cfg.explorerTx ? ` (${cfg.explorerTx}${htlc.hash})` : ''}`);
  if (usdc) console.log(`MockUSDC ${usdc.address}`);
  recordEvmDeployment(CONFIG, key, htlc.address, usdc?.address);
  console.log(`config/networks.json → evm.${key} updated`);
}
