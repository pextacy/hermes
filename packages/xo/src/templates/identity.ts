import type { Engine } from '@xo-cash/engine';

export type XOTemplate = Exclude<Parameters<Engine['importTemplate']>[0], string>;

/**
 * Hermes ID — identity NFT template (Decentralized Identity bounty stretch goal:
 * CashTokens commitments). The NFT is a mutable CashToken held at the identity's
 * token-aware P2PKH address; commitment = SHA-256(nostr pubkey) || seq (uint32 LE),
 * which pins the current binding version (docs/PLAN.md §2.2, packages/id/src/nft.ts).
 *
 * `mintIdentity` creates the category (genesis: the category is the txid of the outpoint
 * spent by input 0, which the app passes as `identityCategory`). `rotateIdentity` is the
 * follow-up the identity locking script offers: spend the NFT and recreate it with the
 * next commitment, in the same flow as a binding rotation.
 */
const ICON = '0000000000000000000000';

export const hermesIdentityTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'Hermes Identity NFT',
  description:
    'A mutable CashTokens NFT whose commitment pins the current version of a BCH ⇄ Nostr identity binding. Rotating the binding updates the commitment.',
  icon: 'identity',
  version: '1',
  supported: ['BCH_2025_05', 'BCH_2026_05'],
  defaults: {
    change: { output: 'changeOutput', role: 'owner', generate: ['ownerKey'] },
    address: { lockingScript: 'identityWallet', role: 'owner', generate: ['ownerKey'] },
  },
  roles: {
    owner: { name: 'Identity owner', description: 'Holds the BCH key of the identity.', icon: 'identity' },
  },
  start: [{ action: 'mintIdentity', role: 'owner', generate: ['ownerKey'] }],
  actions: {
    mintIdentity: {
      name: 'Create identity NFT',
      description: 'Mint the identity NFT pinning binding version $(<identityCommitment>).',
      icon: 'identity',
      roles: {
        owner: {
          generate: ['ownerKey'],
          requirements: { variables: ['identityCategory', 'identityCommitment'] },
        },
      },
      requirements: { participants: [{ role: 'owner', slots: { min: 1, max: 1 } }] },
      transaction: 'mintTransaction',
    },
    rotateIdentity: {
      name: 'Rotate identity',
      description: 'Update the identity NFT to pin a new binding version.',
      icon: 'rotate',
      roles: {
        owner: {
          requirements: {
            secrets: ['ownerKey'],
            variables: ['identityCategory', 'identityCommitment', 'nextIdentityCommitment', 'nextOwnerLockingScript'],
          },
        },
      },
      requirements: { participants: [{ role: 'owner', slots: { min: 1, max: 1 } }] },
      transaction: 'rotateTransaction',
    },
  },
  transactions: {
    mintTransaction: {
      name: 'Identity created',
      description: 'Minted the identity NFT.',
      icon: 'identity',
      inputs: [],
      outputs: [{ output: 'identityOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
      composable: true,
    },
    rotateTransaction: {
      name: 'Identity rotated',
      description: 'Updated the identity NFT commitment to $(<nextIdentityCommitment>).',
      icon: 'rotate',
      inputs: [{ input: 'identityInput', inputIndex: 0 }],
      outputs: [{ output: 'rotatedIdentityOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
      composable: true,
    },
  },
  inputs: {
    identityInput: {
      name: 'Identity NFT',
      description: 'The current identity NFT.',
      icon: 'identity',
      valueSatoshis: '$(<identitySatoshis>)',
      token: {
        category: '$(<identityCategory>)',
        amount: null,
        nft: { capability: 'mutable', commitment: '$(<identityCommitment>)' },
      },
      unlockingScript: 'ownerUnlock',
    },
  },
  outputs: {
    changeOutput: { name: 'Change', description: 'Change.', icon: 'receive', lockingScript: 'identityWallet' },
    identityOutput: {
      name: 'Identity NFT',
      description: 'Identity NFT with commitment $(<identityCommitment>).',
      icon: 'identity',
      lockingScript: 'identityWallet',
      valueSatoshis: '$(<identitySatoshis>)',
      token: {
        category: '$(<identityCategory>)',
        amount: null,
        nft: { capability: 'mutable', commitment: '$(<identityCommitment>)' },
      },
    },
    rotatedIdentityOutput: {
      name: 'Identity NFT (rotated)',
      description: 'Identity NFT with commitment $(<nextIdentityCommitment>).',
      icon: 'rotate',
      // After a BCH key rotation the NFT moves to the new key's token address.
      lockingScript: '$(<nextOwnerLockingScript>)',
      valueSatoshis: '$(<identitySatoshis>)',
      token: {
        category: '$(<identityCategory>)',
        amount: null,
        nft: { capability: 'mutable', commitment: '$(<nextIdentityCommitment>)' },
      },
    },
  },
  lockingScripts: {
    identityWallet: {
      name: 'Identity wallet',
      description: 'Token-aware P2PKH address of the identity BCH key.',
      icon: 'address',
      lockingType: 'p2pkh',
      lockingBytecode: 'ownerP2pkh',
      unlockingBytecode: 'ownerUnlock',
      actions: [],
      roles: {
        owner: {
          state: { secrets: ['ownerKey'] },
          actions: [{ action: 'rotateIdentity', role: 'owner', secrets: [{ ownerKey: null }] }],
          balance: { satoshis: true, fungibleTokens: true, nonfungibleTokens: true },
          selectable: true,
        },
      },
    },
  },
  scripts: {
    ownerP2pkh: 'OP_DUP OP_HASH160 <$(<ownerKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
    ownerUnlock: '<ownerKey.schnorr_signature.all_outputs> <ownerKey.public_key>',
  },
  constants: {
    identitySatoshis: {
      name: 'Identity NFT satoshis',
      description: 'Satoshis carried by the identity NFT output.',
      type: 'satoshis',
      value: '1000n',
    },
  },
  variables: {
    ownerKey: { name: 'Identity key', description: 'The BCH key bound to the Nostr identity.', type: 'private_key' },
    identityCategory: {
      name: 'Identity category',
      description: 'Token category of the identity NFT (txid of the genesis input outpoint).',
      type: 'token_category',
    },
    identityCommitment: {
      name: 'Commitment',
      description: 'SHA-256(nostr pubkey) || seq (uint32 LE), 36 bytes.',
      type: 'token_commitment',
    },
    nextIdentityCommitment: { name: 'Next commitment', description: 'Commitment for the rotated binding.', type: 'token_commitment' },
    nextOwnerLockingScript: {
      name: 'Next owner',
      description: 'Locking script of the (possibly rotated) identity key.',
      type: 'locking_script',
    },
  },
  icons: ['identity', 'rotate', 'receive', 'address'].map((name) => ({ name, hash: ICON })),
} as unknown as XOTemplate;
