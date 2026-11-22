import type { Engine } from '@xo-cash/engine';

export type XOTemplate = Exclude<Parameters<Engine['importTemplate']>[0], string>;

/**
 * Hermes HTLC — XO template (Build With XO bounty, docs/PLAN.md §4.3).
 *
 * Roles: `initiator` locks funds (BCH or CashTokens such as PUSD) against a SHA-256
 * hashlock; `counterparty` claims with the 32-byte secret before `timeout`; after
 * `timeout` the initiator refunds. `claim` / `refund` are follow-up actions offered by
 * the HTLC locking script to each role, so a wallet that holds the HTLC UTXO sees them.
 *
 * The redeem script is the same contract as contracts/HermesHtlc.cash (CashScript) and
 * packages/solid (SolidCash): signature + hashlock + preimage length, and a covenant that
 * the paid-out output at the same index is P2PKH to the beneficiary, keeps the token
 * category and amount, and loses at most `maximumFeeSatoshis`.
 */
const ICON = '0000000000000000000000';

const htlcRoles = {
  initiator: {
    state: { variables: ['hashlock', 'timeout', 'counterpartyPublicKey'], secrets: ['initiatorKey'] },
    actions: [
      { action: 'refund', role: 'initiator', secrets: [{ initiatorKey: null }] },
      { action: 'refundTokens', role: 'initiator', secrets: [{ initiatorKey: null }] },
    ],
    balance: { satoshis: true, fungibleTokens: true, nonfungibleTokens: true },
    selectable: false,
  },
  counterparty: {
    state: { variables: ['hashlock', 'timeout', 'initiatorPublicKey'], secrets: ['counterpartyKey'] },
    actions: [
      { action: 'claim', role: 'counterparty', secrets: [{ counterpartyKey: null }] },
      { action: 'claimTokens', role: 'counterparty', secrets: [{ counterpartyKey: null }] },
    ],
    balance: { satoshis: true, fungibleTokens: true, nonfungibleTokens: true },
    selectable: false,
  },
};

const bothParticipants = [
  { role: 'initiator', slots: { min: 1, max: 1 } },
  { role: 'counterparty', slots: { min: 1, max: 1 } },
];

export const hermesHtlcTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'Hermes HTLC',
  description:
    'Hash time-locked contract for trust-minimised cross-chain swaps: funds locked to a SHA-256 hashlock are claimed with the 32-byte secret before a timeout, or refunded to the locker after it.',
  icon: 'htlc',
  version: '1',
  supported: ['BCH_2025_05', 'BCH_2026_05'],
  resources: [
    {
      name: 'Hermes',
      description: 'Identity-native cross-chain dollar rail for Bitcoin Cash; the EVM side uses the same SHA-256 hashlock.',
      url: 'https://dorahacks.io/hackathon/bchblaze2026/detail',
    },
  ],
  defaults: {
    change: { output: 'changeOutput', role: 'initiator', generate: ['initiatorKey'] },
  },
  roles: {
    initiator: {
      name: 'Initiator',
      description: 'Locks the funds and can refund them after the timeout.',
      icon: 'initiator',
    },
    counterparty: {
      name: 'Counterparty',
      description: 'Knows (or will learn) the secret and claims the funds before the timeout.',
      icon: 'counterparty',
    },
  },
  start: [
    { action: 'lock', role: 'initiator', generate: ['initiatorKey'] },
    { action: 'lockTokens', role: 'initiator', generate: ['initiatorKey'] },
  ],
  actions: {
    lock: {
      name: 'Lock BCH',
      description: 'Lock $(<lockedSatoshis>) satoshis in an HTLC for the counterparty.',
      icon: 'lock',
      roles: {
        initiator: {
          name: 'Lock funds',
          description: 'Provide the hashlock, the timeout and the funds.',
          generate: ['initiatorKey'],
          requirements: { variables: ['initiatorPublicKey', 'hashlock', 'timeout', 'lockedSatoshis'] },
        },
        counterparty: {
          name: 'Provide claim key',
          description: 'Share the public key that will claim the funds.',
          generate: ['counterpartyKey'],
          requirements: { variables: ['counterpartyPublicKey'] },
        },
      },
      requirements: { participants: bothParticipants },
      transaction: 'lockTransaction',
    },
    lockTokens: {
      name: 'Lock tokens',
      description: 'Lock $(<lockedTokenAmount>) fungible tokens in an HTLC for the counterparty.',
      icon: 'lock',
      roles: {
        initiator: {
          name: 'Lock tokens',
          description: 'Provide the hashlock, the timeout and the tokens.',
          generate: ['initiatorKey'],
          requirements: {
            variables: ['initiatorPublicKey', 'hashlock', 'timeout', 'lockedTokenCategory', 'lockedTokenAmount'],
          },
        },
        counterparty: {
          name: 'Provide claim key',
          description: 'Share the public key that will claim the tokens.',
          generate: ['counterpartyKey'],
          requirements: { variables: ['counterpartyPublicKey'] },
        },
      },
      requirements: { participants: bothParticipants },
      transaction: 'lockTokensTransaction',
    },
    claim: {
      name: 'Claim with secret',
      description: 'Reveal the secret and receive the locked satoshis.',
      icon: 'claim',
      roles: {
        counterparty: { requirements: { secrets: ['counterpartyKey'], variables: ['secret', 'lockedSatoshis'] } },
      },
      requirements: { participants: [{ role: 'counterparty', slots: { min: 1, max: 1 } }] },
      transaction: 'claimTransaction',
    },
    claimTokens: {
      name: 'Claim tokens with secret',
      description: 'Reveal the secret and receive the locked tokens.',
      icon: 'claim',
      roles: {
        counterparty: {
          requirements: { secrets: ['counterpartyKey'], variables: ['secret', 'lockedTokenCategory', 'lockedTokenAmount'] },
        },
      },
      requirements: { participants: [{ role: 'counterparty', slots: { min: 1, max: 1 } }] },
      transaction: 'claimTokensTransaction',
    },
    refund: {
      name: 'Refund after timeout',
      description: 'Return the locked satoshis to the initiator once the timeout has passed.',
      icon: 'refund',
      roles: { initiator: { requirements: { secrets: ['initiatorKey'], variables: ['lockedSatoshis'] } } },
      requirements: { participants: [{ role: 'initiator', slots: { min: 1, max: 1 } }] },
      transaction: 'refundTransaction',
    },
    refundTokens: {
      name: 'Refund tokens after timeout',
      description: 'Return the locked tokens to the initiator once the timeout has passed.',
      icon: 'refund',
      roles: {
        initiator: { requirements: { secrets: ['initiatorKey'], variables: ['lockedTokenCategory', 'lockedTokenAmount'] } },
      },
      requirements: { participants: [{ role: 'initiator', slots: { min: 1, max: 1 } }] },
      transaction: 'refundTokensTransaction',
    },
  },
  transactions: {
    lockTransaction: {
      name: 'HTLC locked',
      description: 'Locked $(<lockedSatoshis>) satoshis until $(<timeout>).',
      icon: 'lock',
      inputs: [],
      outputs: [{ output: 'htlcOutput' }],
      version: 2,
      locktime: 0,
      composable: true,
    },
    lockTokensTransaction: {
      name: 'HTLC locked (tokens)',
      description: 'Locked $(<lockedTokenAmount>) tokens until $(<timeout>).',
      icon: 'lock',
      inputs: [],
      outputs: [{ output: 'htlcTokenOutput' }],
      version: 2,
      locktime: 0,
      composable: true,
    },
    claimTransaction: {
      name: 'HTLC claimed',
      description: 'Claimed the HTLC by revealing the secret.',
      icon: 'claim',
      inputs: [{ input: 'htlcClaimInput', inputIndex: 0 }],
      outputs: [{ output: 'claimOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
    },
    claimTokensTransaction: {
      name: 'HTLC claimed (tokens)',
      description: 'Claimed the token HTLC by revealing the secret.',
      icon: 'claim',
      inputs: [{ input: 'htlcClaimTokensInput', inputIndex: 0 }],
      outputs: [{ output: 'claimTokensOutput', outputIndex: 0 }],
      version: 2,
      locktime: 0,
    },
    refundTransaction: {
      name: 'HTLC refunded',
      description: 'Refunded the HTLC after the timeout.',
      icon: 'refund',
      inputs: [{ input: 'htlcRefundInput', inputIndex: 0 }],
      outputs: [{ output: 'refundOutput', outputIndex: 0 }],
      version: 2,
      locktime: '$(<timeout>)',
    },
    refundTokensTransaction: {
      name: 'HTLC refunded (tokens)',
      description: 'Refunded the token HTLC after the timeout.',
      icon: 'refund',
      inputs: [{ input: 'htlcRefundTokensInput', inputIndex: 0 }],
      outputs: [{ output: 'refundTokensOutput', outputIndex: 0 }],
      version: 2,
      locktime: '$(<timeout>)',
    },
  },
  inputs: {
    htlcClaimInput: {
      name: 'HTLC',
      description: 'The HTLC being claimed.',
      icon: 'htlc',
      valueSatoshis: '$(<lockedSatoshis>)',
      token: null,
      unlockingScript: 'claimUnlockingBytecode',
    },
    htlcClaimTokensInput: {
      name: 'HTLC (tokens)',
      description: 'The token HTLC being claimed.',
      icon: 'htlc',
      valueSatoshis: '$(<tokenHtlcSatoshis>)',
      token: { category: '$(<lockedTokenCategory>)', amount: '$(<lockedTokenAmount>)', nft: null },
      unlockingScript: 'claimUnlockingBytecode',
    },
    htlcRefundInput: {
      name: 'HTLC',
      description: 'The HTLC being refunded.',
      icon: 'htlc',
      valueSatoshis: '$(<lockedSatoshis>)',
      token: null,
      sequenceNumber: 4294967294,
      unlockingScript: 'refundUnlockingBytecode',
    },
    htlcRefundTokensInput: {
      name: 'HTLC (tokens)',
      description: 'The token HTLC being refunded.',
      icon: 'htlc',
      valueSatoshis: '$(<tokenHtlcSatoshis>)',
      token: { category: '$(<lockedTokenCategory>)', amount: '$(<lockedTokenAmount>)', nft: null },
      sequenceNumber: 4294967294,
      unlockingScript: 'refundUnlockingBytecode',
    },
  },
  outputs: {
    changeOutput: {
      name: 'Change',
      description: 'Change returned to the initiator.',
      icon: 'receive',
      lockingScript: 'initiatorWallet',
    },
    htlcOutput: {
      name: 'HTLC',
      description: '$(<lockedSatoshis>) satoshis locked until $(<timeout>).',
      icon: 'htlc',
      lockingScript: 'htlcLockingScript',
      valueSatoshis: '$(<lockedSatoshis>)',
      token: null,
    },
    htlcTokenOutput: {
      name: 'HTLC (tokens)',
      description: '$(<lockedTokenAmount>) tokens locked until $(<timeout>).',
      icon: 'htlc',
      lockingScript: 'htlcLockingScript',
      valueSatoshis: '$(<tokenHtlcSatoshis>)',
      token: { category: '$(<lockedTokenCategory>)', amount: '$(<lockedTokenAmount>)', nft: null },
    },
    claimOutput: {
      name: 'Claimed funds',
      description: 'Satoshis paid to the counterparty.',
      icon: 'receive',
      lockingScript: 'counterpartyWallet',
      valueSatoshis: '$(<lockedSatoshis> <spendFeeSatoshis> OP_SUB)',
      token: null,
    },
    claimTokensOutput: {
      name: 'Claimed tokens',
      description: 'Tokens paid to the counterparty.',
      icon: 'receive',
      lockingScript: 'counterpartyWallet',
      valueSatoshis: '$(<tokenHtlcSatoshis> <spendFeeSatoshis> OP_SUB)',
      token: { category: '$(<lockedTokenCategory>)', amount: '$(<lockedTokenAmount>)', nft: null },
    },
    refundOutput: {
      name: 'Refunded funds',
      description: 'Satoshis returned to the initiator.',
      icon: 'receive',
      lockingScript: 'initiatorWallet',
      valueSatoshis: '$(<lockedSatoshis> <spendFeeSatoshis> OP_SUB)',
      token: null,
    },
    refundTokensOutput: {
      name: 'Refunded tokens',
      description: 'Tokens returned to the initiator.',
      icon: 'receive',
      lockingScript: 'initiatorWallet',
      valueSatoshis: '$(<tokenHtlcSatoshis> <spendFeeSatoshis> OP_SUB)',
      token: { category: '$(<lockedTokenCategory>)', amount: '$(<lockedTokenAmount>)', nft: null },
    },
  },
  lockingScripts: {
    htlcLockingScript: {
      name: 'Hermes HTLC',
      description: 'Claimable with the secret before the timeout, refundable after it.',
      icon: 'htlc',
      lockingType: 'p2sh',
      lockingBytecode: 'htlcRedeemBytecode',
      state: { variables: ['hashlock', 'timeout', 'initiatorPublicKey', 'counterpartyPublicKey'] },
      actions: [],
      roles: htlcRoles,
    },
    initiatorWallet: {
      name: 'Initiator wallet',
      description: 'P2PKH of the initiator key (refunds and change).',
      icon: 'address',
      lockingType: 'p2pkh',
      lockingBytecode: 'initiatorP2pkh',
      unlockingBytecode: 'initiatorP2pkhUnlock',
      actions: [],
      roles: {
        initiator: {
          state: { secrets: ['initiatorKey'] },
          balance: { satoshis: true, fungibleTokens: true, nonfungibleTokens: true },
          selectable: true,
        },
      },
    },
    counterpartyWallet: {
      name: 'Counterparty wallet',
      description: 'P2PKH of the counterparty key (claims).',
      icon: 'address',
      lockingType: 'p2pkh',
      lockingBytecode: 'counterpartyP2pkh',
      unlockingBytecode: 'counterpartyP2pkhUnlock',
      actions: [],
      roles: {
        counterparty: {
          state: { secrets: ['counterpartyKey'] },
          balance: { satoshis: true, fungibleTokens: true, nonfungibleTokens: true },
          selectable: true,
        },
      },
    },
  },
  scripts: {
    initiatorP2pkh: 'OP_DUP OP_HASH160 <$(<initiatorKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
    initiatorP2pkhUnlock: '<initiatorKey.schnorr_signature.all_outputs> <initiatorKey.public_key>',
    counterpartyP2pkh: 'OP_DUP OP_HASH160 <$(<counterpartyKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
    counterpartyP2pkhUnlock: '<counterpartyKey.schnorr_signature.all_outputs> <counterpartyKey.public_key>',

    // Covenant shared by both paths: the output at this input's index keeps the token
    // category and amount and loses at most 3000 satoshis (maximumFeeSatoshis).
    // Each party holds only its own key, so the shared script uses the public-key variables.
    enforceTokensPreserved:
      'OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_EQUALVERIFY ' +
      'OP_INPUTINDEX OP_OUTPUTTOKENAMOUNT OP_INPUTINDEX OP_UTXOTOKENAMOUNT OP_NUMEQUALVERIFY ' +
      'OP_INPUTINDEX OP_OUTPUTVALUE <3000> OP_ADD OP_INPUTINDEX OP_UTXOVALUE OP_GREATERTHANOREQUAL OP_VERIFY',
    enforcePaysCounterparty:
      'OP_INPUTINDEX OP_OUTPUTBYTECODE <0x76a914> <$(<counterpartyPublicKey> OP_HASH160)> OP_CAT <0x88ac> OP_CAT OP_EQUALVERIFY',
    enforcePaysInitiator:
      'OP_INPUTINDEX OP_OUTPUTBYTECODE <0x76a914> <$(<initiatorPublicKey> OP_HASH160)> OP_CAT <0x88ac> OP_CAT OP_EQUALVERIFY',

    // Stack on entry — claim: <sig> <secret> OP_1 ; refund: <sig> OP_0
    htlcRedeemBytecode:
      'OP_IF ' +
      'OP_SIZE <32> OP_EQUALVERIFY OP_SHA256 <hashlock> OP_EQUALVERIFY ' +
      'enforceTokensPreserved enforcePaysCounterparty ' +
      '<counterpartyPublicKey> OP_CHECKSIG ' +
      'OP_ELSE ' +
      '<timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP ' +
      'enforceTokensPreserved enforcePaysInitiator ' +
      '<initiatorPublicKey> OP_CHECKSIG ' +
      'OP_ENDIF',
    claimUnlockingBytecode: '<counterpartyKey.schnorr_signature.all_outputs> <secret> OP_1',
    refundUnlockingBytecode: '<initiatorKey.schnorr_signature.all_outputs> OP_0',
  },
  constants: {
    maximumFeeSatoshis: {
      name: 'Maximum fee',
      description: 'Largest fee a claim or refund may take from the HTLC value.',
      type: 'satoshis',
      value: '3000n',
    },
    spendFeeSatoshis: {
      name: 'Spend fee',
      description: 'Fee paid by a claim or refund transaction.',
      type: 'satoshis',
      value: '1500n',
    },
    tokenHtlcSatoshis: {
      name: 'Token HTLC satoshis',
      description: 'Satoshis carried by a token HTLC: token dust plus the spend fee.',
      type: 'satoshis',
      value: '2500n',
    },
  },
  variables: {
    initiatorKey: { name: 'Initiator key', description: 'Key that locks and can refund.', type: 'private_key' },
    counterpartyKey: { name: 'Counterparty key', description: 'Key that claims with the secret.', type: 'private_key' },
    initiatorPublicKey: { name: 'Initiator public key', description: 'Public key of the initiator.', type: 'public_key' },
    counterpartyPublicKey: { name: 'Counterparty public key', description: 'Public key of the counterparty.', type: 'public_key' },
    hashlock: {
      name: 'Hashlock',
      description: 'SHA-256 of the 32-byte secret. The same value locks the other chain’s leg.',
      type: 'bytes',
      hint: '32 bytes, hex',
    },
    secret: { name: 'Secret', description: 'The 32-byte preimage of the hashlock.', type: 'bytes', hint: '32 bytes, hex' },
    timeout: {
      name: 'Timeout',
      description: 'Unix time after which the initiator may refund. The leg locked first has the longer timeout.',
      type: 'timestamp',
    },
    lockedSatoshis: { name: 'Locked amount', description: 'Satoshis locked in the HTLC.', type: 'satoshis' },
    lockedTokenCategory: { name: 'Token', description: 'Category of the locked fungible tokens (e.g. PUSD).', type: 'token_category' },
    lockedTokenAmount: { name: 'Token amount', description: 'Fungible token amount locked, in base units.', type: 'token_amount' },
  },
  icons: ['htlc', 'initiator', 'counterparty', 'lock', 'claim', 'refund', 'receive', 'address'].map((name) => ({ name, hash: ICON })),
} as unknown as XOTemplate;
