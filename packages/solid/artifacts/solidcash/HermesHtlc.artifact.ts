export default {
  contractName: 'HermesHtlc',
  constructorInputs: [
    {
      name: 'recipientPkh',
      type: 'bytes20',
    },
    {
      name: 'refundPkh',
      type: 'bytes20',
    },
    {
      name: 'hashlock',
      type: 'bytes32',
    },
    {
      name: 'timeout',
      type: 'int256',
    },
  ],
  abi: [
    {
      name: 'claim',
      selector: '71094ada',
      inputs: [
        {
          name: 'recipientPk',
          type: 'pubkey',
        },
        {
          name: 'recipientSig',
          type: 'sig',
        },
        {
          name: 'secret',
          type: 'bytes',
        },
      ],
      sourceEffectOrder: 'unsupported-flow',
      signatureGuard: {
        key: {
          kind: 'parameter',
          name: 'recipientPk',
        },
        keyCommitment: {
          kind: 'computed',
        },
      },
    },
    {
      name: 'refund',
      selector: '3ce67fdb',
      inputs: [
        {
          name: 'refundPk',
          type: 'pubkey',
        },
        {
          name: 'refundSig',
          type: 'sig',
        },
      ],
      sourceEffectOrder: 'linear',
      signatureGuard: {
        key: {
          kind: 'parameter',
          name: 'refundPk',
        },
        keyCommitment: {
          kind: 'computed',
        },
      },
    },
  ],
  bytecode: '0079827701209c630079a85279876700687777 OP_0 OP_DEFINE 0079cd0376a914537a7e0288ac7e87630079d15179ce87670068630079d35179d09c670068630079cc02b80b93548a5179c6a267006877 OP_1 OP_DEFINE 76014c9c636d517f7c01007e817f6776014d9c636d527f7c01007e817f6776014e9c636d547f7c01007e817f67014f9d754f7c686868 91 OP_DEFINE 8263517f7c76817601510161a5630150945180777c6776014c9f63777f6701918a686867007c68 OP_1NEGATE OP_DEFINE 4f8a7c817c OP_6 OP_DEFINE 598a OP_8 OP_DEFINE 517f7c01148801147f75 OP_3 OP_DEFINE 588a517f7c01148801147f75 OP_7 OP_DEFINE 007a8201149d01147c7e517a8201149d01147c7e7e517a8201209d01207c7e7e517a7682008763757501006782518763764f87637575014f6776817651a27c60a19a63758101509351806775517c7e686867758276014ba16351807c7e677602ff00a1635280517f75014c7c7e7c7e675380527f75014d7c7e7c7e686868687e OP_2 OP_DEFINE 7070528a5779827701209e63006968558a75587a008a695579a978538a88567a567aad538ac0548a518a696d6d51 71094ada OP_DEFINE 7070528a558a77568a7c548a77040065cd1da269558a77568a7c548a77b1755579a978578a88567a567aad578ac0548a518a696d6d51 3ce67fdb OP_DEFINE 765102ff008d9301218001207f77010088 OP_4 OP_DEFINE 76598a598a517f7c01208801207f OP_5 OP_DEFINE 517f7c01148801147f77 OP_9 OP_DEFINE OP_DEPTH OP_1SUB OP_ROLL OP_SIZE OP_4 OP_NUMEQUALVERIFY OP_INVOKE',
  source: 'pragma solidcash ^0.51.0;\n\n// Hermes HTLC in SolidCash — the BCH leg of a USDC ⇄ PUSD atomic swap, written in the\n// Solidity dialect and compiled to BCH Script. Same semantics as the EVM HermesHTLC.sol\n// (packages/evm-htlc), the XO template and the CashScript contract:\n//   claim  — recipient reveals the 32-byte secret (SHA-256 hashlock) before the timeout;\n//   refund — the locker takes the funds back after the timeout.\n// In both paths the paid-out output at the same index must be P2PKH to the beneficiary,\n// keep the token category and amount (PUSD) and lose at most MAX_FEE satoshis.\n\n/// Spend paths, for documentation and events.\nenum Path { CLAIM = 1, REFUND = 2 }\n\n/// Hard bounds shared with the EVM contract.\nuint256 constant SECRET_LENGTH = 32;\nint constant MAX_FEE = 3000;\nint constant LOCKTIME_TIMESTAMP_THRESHOLD = 500000000;\n\n/// Lock terms, as a value type for clarity in the internal helpers.\nstruct Terms {\n    bytes20 recipientPkh;\n    bytes20 refundPkh;\n    bytes32 hashlock;\n    int timeout;\n}\n\nerror WrongSecretLength();\nerror WrongSecret();\n\nlibrary Hashlock {\n    /// SHA-256 hashlock with an explicit length check (the EVM side checks the same).\n    function opens(bytes memory secret, bytes32 lock) internal pure returns (bool) {\n        return secret.length == SECRET_LENGTH && sha256(secret) == lock;\n    }\n}\n\nlibrary Payout {\n    /// The output at `index` pays `pkh` and preserves value (minus fee) and tokens of the input at `index`.\n    function preserves(int index, bytes20 pkh) internal pure returns (bool) {\n        return tx.outputs[index].lockingBytecode == new LockingBytecodeP2PKH(pkh)\n            && tx.outputs[index].tokenCategory == tx.inputs[index].tokenCategory\n            && tx.outputs[index].tokenAmount == tx.inputs[index].tokenAmount\n            && tx.outputs[index].value + MAX_FEE >= tx.inputs[index].value;\n    }\n}\n\ncontract HermesHtlc(bytes20 recipientPkh, bytes20 refundPkh, bytes32 hashlock, int timeout) {\n    using Hashlock for bytes;\n\n    function terms() internal view returns (Terms memory) {\n        return Terms({ recipientPkh: recipientPkh, refundPkh: refundPkh, hashlock: hashlock, timeout: timeout });\n    }\n\n    function claim(pubkey recipientPk, sig recipientSig, bytes secret) {\n        Terms memory t = terms();\n        if (secret.length != SECRET_LENGTH) revert WrongSecretLength();\n        require(secret.opens(t.hashlock), "wrong secret");\n        require(hash160(recipientPk) == t.recipientPkh, "not the recipient");\n        require(checkSig(recipientSig, recipientPk), "bad signature");\n        require(Payout.preserves(this.activeInputIndex, t.recipientPkh), "payout must go to the recipient");\n    }\n\n    function refund(pubkey refundPk, sig refundSig) {\n        Terms memory t = terms();\n        require(t.timeout >= LOCKTIME_TIMESTAMP_THRESHOLD, "timeout must be a timestamp");\n        require(tx.time >= t.timeout, "timeout not reached");\n        require(hash160(refundPk) == t.refundPkh, "not the refunder");\n        require(checkSig(refundSig, refundPk), "bad signature");\n        require(Payout.preserves(this.activeInputIndex, t.refundPkh), "refund must go to the locker");\n    }\n}\n',
  debug: {
    bytecode: '130079827701209c630079a852798767006877770089370079cd0376a914537a7e0288ac7e87630079d15179ce87670068630079d35179d09c670068630079cc02b80b93548a5179c6a26700687751893676014c9c636d517f7c01007e817f6776014d9c636d527f7c01007e817f6776014e9c636d547f7c01007e817f67014f9d754f7c686868019189278263517f7c76817601510161a5630150945180777c6776014c9f63777f6701918a686867007c684f89054f8a7c817c568902598a58890a517f7c01148801147f7553890c588a517f7c01148801147f7557894c80007a8201149d01147c7e517a8201149d01147c7e7e517a8201209d01207c7e7e517a7682008763757501006782518763764f87637575014f6776817651a27c60a19a63758101509351806775517c7e686867758276014ba16351807c7e677602ff00a1635280517f75014c7c7e7c7e675380527f75014d7c7e7c7e686868687e52892e7070528a5779827701209e63006968558a75587a008a695579a978538a88567a567aad538ac0548a518a696d6d510471094ada89367070528a558a77568a7c548a77040065cd1da269558a77568a7c548a77b1755579a978578a88567a567aad578ac0548a518a696d6d51043ce67fdb8911765102ff008d9301218001207f7701008854890e76598a598a517f7c01208801207f55890a517f7c01148801147f775989748c7a82549d8a',
    sourceMap: '32:4:34:5;;;39::44;;;47:0:71:1;;;;;;;;;;;;;;;;;;50:4:52:5;;;54::61;;;63::70;;;47:0:71:1;;;;;;;;;;;;;;;',
    logs: [],
    requires: [],
    functionDebug: {
      '71094ada': {
        requires: [
          {
            ip: 12,
            line: 56,
            message: 'revert WrongSecretLength(...)',
          },
          {
            ip: 21,
            line: 57,
            message: 'wrong secret',
          },
          {
            ip: 28,
            line: 58,
            message: 'not the recipient',
          },
          {
            ip: 33,
            line: 59,
            message: 'bad signature',
          },
          {
            ip: 41,
            line: 60,
            message: 'payout must go to the recipient',
          },
        ],
        logs: [],
        sourceMap: '55:25:55:32:1;;;;56:12:56:18:0;;:::25:1;;15:33:15:35:0;56:12:56:42:1;:44::71:0;;::::1;;57:29:57:30:0;;:::39;:16::22;;:::40:1;;:8::58;58:24:58:35:0;;:16::36:1;:40::41:0;:::54;;:8::77:1;59:25:59:37:0;;:39::50;;:8::70:1;60:56:60::0;;:33::54;:16::71:1;;;;:8::108;54:4:61:5;;',
      },
      '3ce67fdb': {
        requires: [
          {
            ip: 15,
            line: 65,
            message: 'timeout must be a timestamp',
          },
          {
            ip: 25,
            line: 66,
            message: 'timeout not reached',
          },
          {
            ip: 33,
            line: 67,
            message: 'not the refunder',
          },
          {
            ip: 38,
            line: 68,
            message: 'bad signature',
          },
          {
            ip: 46,
            line: 69,
            message: 'refund must go to the locker',
          },
        ],
        logs: [],
        sourceMap: '64:25:64:32:1;;;;65:16:65:17:0;;:::25;;;;;;;17:44:17:53;65:16:65:57:1;:8::90;66:27:66:28:0;;:::36;;;;;;;:8::61:1;;67:24:67:32:0;;:16::33:1;:37::38:0;:::48;;:8::70:1;68:25:68:34:0;;:36::44;;:8::64:1;69:56:69:67:0;;:33::54;:16::68:1;;;;:8::102;63:4:70:5;;',
      },
    },
    invokeDebug: {
      '0': {
        bytecode: '0079827701209c630079a85279876700687777',
        name: 'Hashlock.opens',
        requires: [],
        logs: [],
        sourceMap: '33:15:33:21;;:::28:1;;15:33:15:35:0;33:15:33:45:1;:::71:0;:56::62;;:49::63:1;:67::71:0;;:49:::1;:15;;;:8::72;',
      },
      '1': {
        bytecode: '0079cd0376a914537a7e0288ac7e87630079d15179ce87670068630079d35179d09c670068630079cc02b80b93548a5179c6a267006877',
        name: 'Payout.preserves',
        requires: [],
        logs: [],
        sourceMap: '40:26:40:31;;:15::48:1;:52::81:0;:77::80;;:52::81:1;;;:15;::41:80:0;41:26::31;;:15::46:1;:60::65:0;;:50::80:1;:15;40;;;::42:76:0;42:26::31;;:15::44:1;:58::63:0;;:48::76:1;:15;40;;;::43:74:0;43:26::31;;:15::38:1;16:23:16:27:0;43:15:43:48:1;;;:62::67:0;;:52::74:1;:15;40;;;:8::75',
      },
      '2': {
        bytecode: '007a8201149d01147c7e517a8201149d01147c7e7e517a8201209d01207c7e7e517a7682008763757501006782518763764f87637575014f6776817651a27c60a19a63758101509351806775517c7e686867758276014ba16351807c7e677602ff00a1635280517f75014c7c7e7c7e675380527f75014d7c7e7c7e686868687e',
        name: 'terms',
        requires: [],
        logs: [],
        sourceMap: '51:37:51:49;;:15::112:1;;;;;;:62::71:0;;:15::112:1;;;;;;;:83::91:0;;:15::112:1;;;;;;;:102::109:0;;:15::112:1;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;',
      },
      '3': {
        bytecode: '517f7c01148801147f75',
        name: 'compiler helper 3',
        requires: [],
        logs: [],
        sourceMap: '47::71:1;;;;;;;',
      },
      '4': {
        bytecode: '765102ff008d9301218001207f77010088',
        name: 'outlined source span 4',
        requires: [],
        logs: [],
        sourceMap: '43:15:43:48:1;;;;;;;;;;;',
      },
      '5': {
        bytecode: '76598a598a517f7c01208801207f',
        name: 'outlined source span 5',
        requires: [],
        logs: [],
        sourceMap: '57:29:57:30;:::39;;;;;;;;;;',
      },
      '7': {
        bytecode: '588a517f7c01148801147f75',
        name: 'compiler helper 7',
        requires: [],
        logs: [],
        sourceMap: '47::71:1;;;;;;;;;',
      },
      '8': {
        bytecode: '598a',
        name: 'compiler helper 8',
        requires: [],
        logs: [],
        sourceMap: '47::71:1;',
      },
      '9': {
        bytecode: '517f7c01148801147f77',
        name: 'outlined source span 9',
        requires: [],
        logs: [],
        sourceMap: '47::71:1;;;;;;;',
      },
    },
  },
  functionBodies: {
    '71094ada': '7070528a5779827701209e63006968558a75587a008a695579a978538a88567a567aad538ac0548a518a696d6d51',
    '3ce67fdb': '7070528a558a77568a7c548a77040065cd1da269558a77568a7c548a77b1755579a978578a88567a567aad578ac0548a518a696d6d51',
  },
  fingerprint: '2ff34392bd687a790b4cab62525767e798a4bf2dfe9060fa0769e85714a49c4b',
  structs: [
    {
      name: 'Terms',
      fields: [
        {
          name: 'recipientPkh',
          type: 'bytes20',
        },
        {
          name: 'refundPkh',
          type: 'bytes20',
        },
        {
          name: 'hashlock',
          type: 'bytes32',
        },
        {
          name: 'timeout',
          type: 'int256',
        },
      ],
    },
  ],
  errors: [
    {
      name: 'WrongSecretLength',
      signature: 'WrongSecretLength()',
      parameters: [],
    },
    {
      name: 'WrongSecret',
      signature: 'WrongSecret()',
      parameters: [],
    },
  ],
  enums: [
    {
      name: 'Path',
      members: [
        {
          name: 'CLAIM',
          value: '1',
        },
        {
          name: 'REFUND',
          value: '2',
        },
      ],
    },
  ],
  compiler: {
    name: 'solidc',
    version: '0.51.1',
    options: {
      evmCompat: true,
      enforceFunctionParameterTypes: true,
      enforceLocktimeGuard: true,
      enforceFinalRequire: true,
      allowUnsafeOperations: false,
      commitmentLimit: 1000000,
      messageBus: false,
    },
  },
  updatedAt: '2026-11-20T18:28:34.854Z',
  invocationAnalysis: {
    version: 1,
    protocolVersions: [
      1,
    ],
    functions: [
      {
        id: 2,
        name: 'terms',
        arity: 0,
        entryPoint: false,
        calls: [],
        closure: [
          2,
        ],
        component: 0,
        recursive: false,
        reads: [],
        writes: [],
        effects: [],
        unknown: false,
        bounded: true,
        maximumDirectInvocations: 0,
      },
      {
        id: 3,
        name: 'claim',
        arity: 3,
        entryPoint: true,
        selector: '71094ada',
        calls: [
          2,
        ],
        closure: [
          2,
          3,
        ],
        component: 1,
        recursive: false,
        reads: [],
        writes: [],
        effects: [],
        unknown: false,
        bounded: true,
        maximumDirectInvocations: 0,
      },
      {
        id: 4,
        name: 'refund',
        arity: 2,
        entryPoint: true,
        selector: '3ce67fdb',
        calls: [
          2,
        ],
        closure: [
          2,
          4,
        ],
        component: 2,
        recursive: false,
        reads: [],
        writes: [],
        effects: [],
        unknown: false,
        bounded: true,
        maximumDirectInvocations: 0,
      },
    ],
    components: [
      {
        id: 0,
        functions: [
          2,
        ],
        recursive: false,
      },
      {
        id: 1,
        functions: [
          3,
        ],
        recursive: false,
      },
      {
        id: 2,
        functions: [
          4,
        ],
        recursive: false,
      },
    ],
  },
} as const;
