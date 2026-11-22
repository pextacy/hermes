/**
 * Hermes HTLC on XO — party-by-party helpers around @xo-cash/engine.
 *
 * Every party runs its own engine (own mnemonic, entered at runtime) and exchanges the
 * invitation as a serialized string (Nostr DM, QR, copy/paste). Received invitations are
 * untrusted data: they are validated with `listInvitationValidationIssues` and must name
 * the pinned Hermes template before anything is signed.
 */
import { Engine, XO_SUPPORTED_NETWORKS, listInvitationValidationIssues } from '@xo-cash/engine';
import { StorageType } from '@xo-cash/state';
import { serializeInvitation, deserializeInvitation } from '@xo-cash/utils';
import { hexToBin } from '@bitauth/libauth';
import { hermesHtlcTemplate } from './templates/htlc.js';
import { hermesIdentityTemplate } from './templates/identity.js';
import { hermesDropsClaimTemplate } from './templates/drops-claim.js';

export type XoNetwork = 'mainnet' | 'chipnet';

export async function openEngine(mnemonic: string, opts: { network: XoNetwork; databasePath?: string; databaseFilename?: string; browser?: boolean }) {
  return Engine.create(mnemonic, {
    network: XO_SUPPORTED_NETWORKS[opts.network],
    storageType: StorageType.INDEXEDDB,
    ...(opts.browser ? {} : { databasePath: opts.databasePath ?? process.env.TMPDIR ?? '/tmp' }),
    databaseFilename: opts.databaseFilename ?? `hermes-xo-${opts.network}`,
  });
}

export async function importHermesTemplates(engine: Engine) {
  const htlc = await engine.importTemplate(hermesHtlcTemplate);
  const identity = await engine.importTemplate(hermesIdentityTemplate);
  const dropsClaim = await engine.importTemplate(hermesDropsClaimTemplate);
  return { htlc: htlc.templateIdentifier, identity: identity.templateIdentifier, dropsClaim: dropsClaim.templateIdentifier };
}

type AnyInvitation = Parameters<Engine['updateInvitation']>[0];

export const exportInvitation = (inv: AnyInvitation): string => serializeInvitation(inv as never) as unknown as string;
export const importInvitation = (data: string): AnyInvitation => deserializeInvitation(data as never) as unknown as AnyInvitation;

/** Reject invitations that are malformed or not for a template we pinned. */
export async function checkIncoming(engine: Engine, inv: AnyInvitation, pinnedTemplateIds: string[]) {
  const template = await engine.getTemplate(inv.templateIdentifier);
  if (!template || !pinnedTemplateIds.includes(inv.templateIdentifier)) {
    throw new Error(`Refusing invitation for unpinned template ${inv.templateIdentifier}`);
  }
  // The network selects xpub (mainnet) vs tpub (chipnet) entity identifiers; without it the engine assumes testnet.
  const issues = (listInvitationValidationIssues as unknown as (...a: unknown[]) => unknown[])(inv, template, engine.network);
  if (Array.isArray(issues) && issues.length) {
    const messages = issues.map((e) => (e instanceof Error ? e.message : JSON.stringify(e)));
    throw new Error(`Invitation has validation issues: ${JSON.stringify(messages)}`);
  }
}

async function ownPublicKey(engine: Engine, secretIdentifier: string, templateIdentifier: string) {
  const all = await engine.listSecretData();
  const s = [...all].reverse().find((x) => x.secretIdentifier === secretIdentifier && x.templateIdentifier === templateIdentifier);
  if (!s) throw new Error(`secret ${secretIdentifier} not generated`);
  const pk = await engine.getSecretPublicKey(s.secretLookupKey);
  if (!pk) throw new Error(`no public key for ${secretIdentifier}`);
  return pk;
}

export interface LockTerms {
  hashlock: string; // hex 32
  timeout: number; // unix seconds
  lockedSatoshis?: number;
  token?: { category: string; amount: bigint };
}

/** Initiator: start a lock (BCH or tokens) and fill in its own terms. */
export async function initiatorCreateLock(engine: Engine, templateIdentifier: string, terms: LockTerms) {
  const action = terms.token ? 'lockTokens' : 'lock';
  const intent = hermesHtlcTemplate.start.find((s: { action: string }) => s.action === action);
  let stored = await engine.createInvitation({ templateIdentifier, actionIdentifier: action, intent });
  const id = stored.invitation.invitationIdentifier;
  const pk = await ownPublicKey(engine, 'initiatorKey', templateIdentifier);
  const v = (variableIdentifier: string, value: unknown) => ({ variableIdentifier, roleIdentifier: 'initiator', value });
  const variables = [v('initiatorPublicKey', pk), v('hashlock', terms.hashlock), v('timeout', terms.timeout)];
  if (terms.token) variables.push(v('lockedTokenCategory', terms.token.category), v('lockedTokenAmount', terms.token.amount));
  else variables.push(v('lockedSatoshis', terms.lockedSatoshis ?? 0));
  stored = await engine.appendInvitation(id, { variables } as never);
  return stored;
}

/** Counterparty: join an incoming lock invitation and provide the claim key. */
export async function counterpartyJoin(engine: Engine, templateIdentifier: string, incoming: AnyInvitation) {
  await checkIncoming(engine, incoming, [templateIdentifier]);
  let stored = await engine.acceptInvitation(incoming, { roleIdentifier: 'counterparty' });
  const id = stored.invitation.invitationIdentifier;
  const pk = await ownPublicKey(engine, 'counterpartyKey', templateIdentifier);
  stored = await engine.appendInvitation(id, {
    variables: [{ variableIdentifier: 'counterpartyPublicKey', roleIdentifier: 'counterparty', value: pk }],
  } as never);
  return stored;
}

/**
 * Initiator: merge the counterparty's commit, resolve the HTLC output, fund it from the
 * engine's own UTXOs, add change, sign and (optionally) broadcast.
 */
export async function initiatorFundAndExecute(
  engine: Engine,
  templateIdentifier: string,
  incoming: AnyInvitation,
  opts: { broadcast: boolean; feeSatoshis?: number },
) {
  await checkIncoming(engine, incoming, [templateIdentifier]);
  let stored = await engine.updateInvitation(incoming);
  const id = stored.invitation.invitationIdentifier;
  const outputIdentifier = stored.invitation.actionIdentifier === 'lockTokens' ? 'htlcTokenOutput' : 'htlcOutput';
  stored = await engine.appendInvitation(id, { outputs: [{ outputIdentifier }] } as never);
  const lockingBytecode = await engine.resolveInvitationOutputLockingBytecode(id, outputIdentifier, 'initiator');

  const spendable = await engine.listSpendableUnspentOutputs();
  const fee = BigInt(opts.feeSatoshis ?? 1000);
  // Value the HTLC output itself needs: the locked satoshis, or the token HTLC's carried satoshis.
  const lockedVar = (stored.invitation.commits ?? [])
    .flatMap((c) => (c as { data?: { variables?: { variableIdentifier: string; value: unknown }[] } }).data?.variables ?? [])
    .find((x) => x.variableIdentifier === 'lockedSatoshis');
  const locked = stored.invitation.actionIdentifier === 'lockTokens' ? 2500n : BigInt(String(lockedVar?.value ?? 0).replace(/n$/, ''));
  const need = locked + fee + 1000n;
  const picked: typeof spendable = [];
  let total = 0n;
  for (const u of spendable) {
    if ((u as { token?: unknown }).token) continue;
    picked.push(u);
    total += BigInt((u as { valueSatoshis: number | bigint }).valueSatoshis);
    if (total >= need + 100_000n) break;
  }
  if (!picked.length) throw new Error('No spendable UTXOs in the XO wallet — fund it on chipnet first.');
  stored = await engine.appendInvitation(id, {
    inputs: picked.map((u) => ({
      outpointTransactionHash: hexToBin((u as { outpointTransactionHash: string }).outpointTransactionHash),
      outpointIndex: (u as { outpointIndex: number }).outpointIndex,
    })),
  } as never);
  stored = await engine.addChangeToInvitation(id);
  for (const inputIndex of await engine.listOwnInputIndexes(id)) stored = await engine.signInvitation(id, inputIndex);
  const result = await engine.executeAction(id, { broadcastTransaction: opts.broadcast });
  return { stored, lockingBytecode, result };
}

/** Follow-up: counterparty claims with the secret (offered by the HTLC locking script). */
export async function followUp(
  engine: Engine,
  templateIdentifier: string,
  action: 'claim' | 'claimTokens' | 'refund' | 'refundTokens',
  vars: Record<string, unknown>,
  opts: { broadcast: boolean },
) {
  const role = action.startsWith('claim') ? 'counterparty' : 'initiator';
  let stored = await engine.createInvitation({ templateIdentifier, actionIdentifier: action, roleIdentifier: role });
  const id = stored.invitation.invitationIdentifier;
  stored = await engine.appendInvitation(id, {
    variables: Object.entries(vars).map(([variableIdentifier, value]) => ({ variableIdentifier, roleIdentifier: role, value })),
  } as never);
  const htlcUtxos = (await engine.listUnspentOutputs()).filter(
    (u) => (u as { lockingScriptIdentifier?: string }).lockingScriptIdentifier === 'htlcLockingScript',
  );
  if (!htlcUtxos.length) throw new Error('HTLC UTXO not found in this XO wallet');
  const u = htlcUtxos[0] as { outpointTransactionHash: string; outpointIndex: number };
  stored = await engine.appendInvitation(id, {
    inputs: [{ inputIdentifier: action.startsWith('claim') ? (action === 'claim' ? 'htlcClaimInput' : 'htlcClaimTokensInput') : action === 'refund' ? 'htlcRefundInput' : 'htlcRefundTokensInput', outpointTransactionHash: hexToBin(u.outpointTransactionHash), outpointIndex: u.outpointIndex }],
    outputs: [{ outputIdentifier: action === 'claim' ? 'claimOutput' : action === 'claimTokens' ? 'claimTokensOutput' : action === 'refund' ? 'refundOutput' : 'refundTokensOutput' }],
  } as never);
  for (const inputIndex of await engine.listOwnInputIndexes(id)) stored = await engine.signInvitation(id, inputIndex);
  return engine.executeAction(id, { broadcastTransaction: opts.broadcast });
}
