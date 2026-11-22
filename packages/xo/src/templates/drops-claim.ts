import type { XOTemplate } from './identity.js';
import shardArtifact from '../../../drops/artifacts/DropsShard.json' with { type: 'json' };
import vaultArtifact from '../../../drops/artifacts/DropsVault.json' with { type: 'json' };

/**
 * Hermes Drops claim — XO template for the FoldingCash pull-claim pool.
 *
 * The covenant scripts are the compiled CashScript contracts (packages/drops/contracts),
 * converted to CashAssembly, so an XO wallet builds exactly the transaction the covenant
 * accepts: inputs 0 shard / 1 vault (/ 2 old receipt), outputs 0 shard′ / 1 vault′ /
 * 2 new receipt / 3 payout. Deployment constants (categories in VM byte order, vault and
 * pending bytecode) are variables taken from the pool's deployment record; the proof and
 * the next shard state come from the published tree. The covenant re-checks all of it.
 */
const ICON = '0000000000000000000000';

/** CashScript artifact ASM → CashAssembly (hex data tokens become pushes). */
export function asmToCashAssembly(asm: string): string {
  return asm
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.startsWith('OP_') ? t : `<0x${t}>`))
    .join(' ');
}

const shardAsm = asmToCashAssembly(shardArtifact.bytecode);
const vaultAsm = asmToCashAssembly(vaultArtifact.bytecode);

const claimRoles = (receipt: boolean) => ({
  claimer: {
    generate: ['claimerKey'],
    requirements: {
      secrets: ['claimerKey'],
      variables: [
        'receiptCategoryVm', 'pendingCategoryVm', 'rewardCategoryVm', 'vaultBytecode', 'pendingBytecode',
        'receiptCategory', 'rewardCategory', 'leafLockingBytecode', 'cumulative', 'accountId', 'proof', 'path',
        'shardSatoshis', 'shardState', 'newShardState', 'vaultSatoshis', 'vaultTokens', 'vaultRemaining', 'payout', 'receiptCommitment',
        ...(receipt ? ['previousReceiptCommitment'] : []),
      ],
    },
  },
});

const v = (name: string, description: string, type: string) => ({ name, description, type });

export const hermesDropsClaimTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'Hermes Drops claim',
  description: 'Claim CashToken rewards from a Hermes Drops pool with a Merkle proof; a receipt NFT records the claimed total.',
  icon: 'drop',
  version: '1',
  supported: ['BCH_2026_05'],
  defaults: { change: { output: 'changeOutput', role: 'claimer', generate: ['claimerKey'] } },
  roles: { claimer: { name: 'Claimer', description: 'An address in the reward tree claiming what it has earned.', icon: 'claimer' } },
  start: [
    { action: 'claim', role: 'claimer', generate: ['claimerKey'] },
    { action: 'claimAgain', role: 'claimer', generate: ['claimerKey'] },
  ],
  actions: {
    claim: {
      name: 'First claim',
      description: 'Claim $(<payout>) reward units for account $(<accountId>) (first claim: sets the account bit, mints the receipt).',
      icon: 'drop',
      roles: claimRoles(false),
      requirements: { participants: [{ role: 'claimer', slots: { min: 1, max: 1 } }] },
      transaction: 'claimTransaction',
    },
    claimAgain: {
      name: 'Claim again',
      description: 'Claim the difference since the last claim; the old receipt is burned and a new one minted.',
      icon: 'drop',
      roles: claimRoles(true),
      requirements: { participants: [{ role: 'claimer', slots: { min: 1, max: 1 } }] },
      transaction: 'claimAgainTransaction',
    },
  },
  transactions: {
    claimTransaction: {
      name: 'Rewards claimed',
      description: 'Claimed $(<payout>) reward units.',
      icon: 'drop',
      inputs: [{ input: 'shardInput', inputIndex: 0 }, { input: 'vaultInput', inputIndex: 1 }],
      outputs: [
        { output: 'shardOutput', outputIndex: 0 },
        { output: 'vaultOutput', outputIndex: 1 },
        { output: 'receiptOutput', outputIndex: 2 },
        { output: 'payoutOutput', outputIndex: 3 },
      ],
      version: 2,
      locktime: 0,
    },
    claimAgainTransaction: {
      name: 'Rewards claimed',
      description: 'Claimed $(<payout>) more reward units.',
      icon: 'drop',
      inputs: [{ input: 'shardAgainInput', inputIndex: 0 }, { input: 'vaultInput', inputIndex: 1 }, { input: 'receiptInput', inputIndex: 2 }],
      outputs: [
        { output: 'shardOutput', outputIndex: 0 },
        { output: 'vaultOutput', outputIndex: 1 },
        { output: 'receiptOutput', outputIndex: 2 },
        { output: 'payoutOutput', outputIndex: 3 },
      ],
      version: 2,
      locktime: 0,
    },
  },
  inputs: {
    shardInput: {
      name: 'Pool shard',
      description: 'The shard holding this account’s claim bit and the active root.',
      icon: 'pool',
      valueSatoshis: '$(<shardSatoshis>)',
      token: { category: '$(<receiptCategory>)', amount: null, nft: { capability: 'minting', commitment: '$(<shardState>)' } },
      unlockingScript: 'shardFirstClaimUnlock',
    },
    shardAgainInput: {
      name: 'Pool shard',
      description: 'The shard holding the active root.',
      icon: 'pool',
      valueSatoshis: '$(<shardSatoshis>)',
      token: { category: '$(<receiptCategory>)', amount: null, nft: { capability: 'minting', commitment: '$(<shardState>)' } },
      unlockingScript: 'shardClaimAgainUnlock',
    },
    vaultInput: {
      name: 'Reward vault',
      description: 'The vault paying the reward.',
      icon: 'pool',
      valueSatoshis: '$(<vaultSatoshis>)',
      token: { category: '$(<rewardCategory>)', amount: '$(<vaultTokens>)', nft: null },
      unlockingScript: 'vaultUnlock',
    },
    receiptInput: {
      name: 'Previous receipt',
      description: 'The receipt NFT from the last claim (burned).',
      icon: 'receipt',
      valueSatoshis: '1000',
      token: { category: '$(<receiptCategory>)', amount: null, nft: { capability: 'none', commitment: '$(<previousReceiptCommitment>)' } },
      unlockingScript: 'claimerUnlock',
    },
  },
  outputs: {
    changeOutput: { name: 'Change', description: 'Change.', icon: 'receive', lockingScript: 'claimerWallet' },
    shardOutput: {
      name: 'Pool shard',
      description: 'Shard continues with the updated claim bitmap.',
      icon: 'pool',
      lockingScript: 'shardScript',
      valueSatoshis: '$(<shardSatoshis>)',
      token: { category: '$(<receiptCategory>)', amount: null, nft: { capability: 'minting', commitment: '$(<newShardState>)' } },
      roles: { claimer: { relevant: false } },
    },
    vaultOutput: {
      name: 'Reward vault',
      description: 'Vault continues minus the payout.',
      icon: 'pool',
      lockingScript: 'vaultScript',
      valueSatoshis: '$(<vaultSatoshis>)',
      token: { category: '$(<rewardCategory>)', amount: '$(<vaultRemaining>)', nft: null },
      roles: { claimer: { relevant: false } },
    },
    receiptOutput: {
      name: 'Receipt',
      description: 'Receipt NFT: account and claimed total.',
      icon: 'receipt',
      lockingScript: 'claimerWallet',
      valueSatoshis: '1000',
      token: { category: '$(<receiptCategory>)', amount: null, nft: { capability: 'none', commitment: '$(<receiptCommitment>)' } },
    },
    payoutOutput: {
      name: 'Reward',
      description: '$(<payout>) reward units.',
      icon: 'drop',
      lockingScript: 'claimerWallet',
      valueSatoshis: '1000',
      token: { category: '$(<rewardCategory>)', amount: '$(<payout>)', nft: null },
    },
  },
  lockingScripts: {
    shardScript: {
      name: 'Drops shard covenant',
      description: 'Verifies Merkle proofs and receipts (DropsShard.cash).',
      icon: 'pool',
      lockingType: 'p2sh',
      lockingBytecode: 'shardRedeem',
      actions: [],
      selectable: false,
      balance: { satoshis: '0n', fungibleTokens: '0n', nonfungibleTokens: 0 },
    },
    vaultScript: {
      name: 'Drops vault covenant',
      description: 'Releases rewards only to a shard claim (DropsVault.cash).',
      icon: 'pool',
      lockingType: 'p2sh',
      lockingBytecode: 'vaultRedeem',
      actions: [],
      selectable: false,
      balance: { satoshis: '0n', fungibleTokens: '0n', nonfungibleTokens: 0 },
    },
    claimerWallet: {
      name: 'Claimer wallet',
      description: 'P2PKH of the claimer key — the leaf’s locking bytecode.',
      icon: 'address',
      lockingType: 'p2pkh',
      lockingBytecode: 'claimerP2pkh',
      unlockingBytecode: 'claimerUnlock',
      actions: [],
      roles: {
        claimer: {
          state: { secrets: ['claimerKey'] },
          actions: [{ action: 'claimAgain', role: 'claimer', secrets: [{ claimerKey: null }] }],
          balance: { satoshis: true, fungibleTokens: true, nonfungibleTokens: true },
          selectable: true,
        },
      },
    },
  },
  scripts: {
    // CashScript pushes constructor arguments in reverse declaration order before the contract code.
    shardRedeem: `<pendingBytecode> <vaultBytecode> <rewardCategoryVm> <pendingCategoryVm> <receiptCategoryVm> ${shardAsm}`,
    vaultRedeem: `<receiptCategoryVm> ${vaultAsm}`,
    // claim(leafLockingBytecode, cumulative, accountId, proof, path, receiptIndex): arguments reversed, then function index 0.
    shardFirstClaimUnlock: '<3> <path> <proof> <accountId> <cumulative> <leafLockingBytecode> OP_0',
    shardClaimAgainUnlock: '<2> <path> <proof> <accountId> <cumulative> <leafLockingBytecode> OP_0',
    vaultUnlock: '',
    claimerP2pkh: 'OP_DUP OP_HASH160 <$(<claimerKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
    claimerUnlock: '<claimerKey.schnorr_signature.all_outputs> <claimerKey.public_key>',
  },
  variables: {
    claimerKey: v('Claimer key', 'Key of the address in the reward tree.', 'private_key'),
    receiptCategoryVm: v('Receipt category (VM order)', 'Receipt category bytes as introspected by the VM (reversed txid).', 'bytes'),
    pendingCategoryVm: v('Authority category (VM order)', 'Root authority category bytes (reversed txid).', 'bytes'),
    rewardCategoryVm: v('Reward category (VM order)', 'Reward token category bytes (reversed txid).', 'bytes'),
    vaultBytecode: v('Vault locking bytecode', 'From the pool deployment record.', 'bytes'),
    pendingBytecode: v('Pending-root locking bytecode', 'From the pool deployment record.', 'bytes'),
    receiptCategory: v('Receipt category', 'Receipt NFT category (txid order).', 'token_category'),
    rewardCategory: v('Reward token', 'Reward token category, e.g. FLDCH.', 'token_category'),
    leafLockingBytecode: v('Leaf address', 'Locking bytecode committed in the leaf (the claimer’s address).', 'locking_script'),
    cumulative: v('Cumulative earned', 'Cumulative entitlement in the active tree (base units).', 'integer'),
    accountId: v('Account id', 'Stable account id in the tree.', 'integer'),
    proof: v('Merkle proof', 'Concatenated 32-byte siblings.', 'bytes'),
    path: v('Proof path', 'Bit i = 1 when the node at level i is a right child.', 'integer'),
    shardSatoshis: v('Shard satoshis', 'Value of the shard UTXO (unchanged).', 'satoshis'),
    shardState: v('Shard state', 'Current shard commitment.', 'token_commitment'),
    newShardState: v('Next shard state', 'Shard commitment with this account’s bit set.', 'token_commitment'),
    vaultSatoshis: v('Vault satoshis', 'Value of the vault UTXO (unchanged).', 'satoshis'),
    vaultTokens: v('Vault tokens', 'Reward tokens in the vault UTXO.', 'token_amount'),
    vaultRemaining: v('Vault remaining', 'Vault tokens after the payout.', 'token_amount'),
    payout: v('Payout', 'cumulative − claimedTotal.', 'token_amount'),
    receiptCommitment: v('New receipt', 'accountId (4 LE) || cumulative (8 LE).', 'token_commitment'),
    previousReceiptCommitment: v('Previous receipt', 'accountId (4 LE) || claimedTotal (8 LE).', 'token_commitment'),
  },
  icons: ['drop', 'claimer', 'pool', 'receipt', 'receive', 'address'].map((name) => ({ name, hash: ICON })),
} as unknown as XOTemplate;
