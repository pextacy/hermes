import hermes from '../../../config/hermes.json' with { type: 'json' };

export const BINDING_DOMAIN = hermes.id.domain; // "hermes-id"
export const BINDING_VERSION = hermes.id.version; // 1
export const BINDING_KIND = 30078; // NIP-78 application data, parameterised replaceable
export const BINDING_D_TAG = 'hermes-id';
export const AUTH_DOMAIN = 'hermes-auth';
export const AUTH_EVENT_KIND = 27235; // ephemeral, never published: carries the Nostr half of a challenge response
export const ROTATION_EVENT_KIND = 27236; // ephemeral, embedded in a rotated binding: old Nostr key approves successor
export const CHALLENGE_FRESHNESS_SECONDS = hermes.id.challengeFreshnessSeconds;
export const RECENT_CHANGE_WARNING_SECONDS = hermes.id.recentChangeWarningSeconds;
export const MIN_RELAYS = hermes.id.minRelays;

/**
 * Prefix for BCH message signatures. The BCH signature is a BCH Schnorr signature
 * (the 2019 BCH Schnorr scheme, as used by OP_CHECKSIG / OP_CHECKDATASIG) over
 * SHA-256(BCH_MESSAGE_PREFIX || message). See docs/PLAN.md §2.1.
 */
export const BCH_MESSAGE_PREFIX = 'Hermes ID signed message:\n';

/** OP_RETURN protocol marker used by the transaction-commitment proof (WizardConnect wallets). */
export const TX_PROOF_MARKER = 'HRMS';
