import { deserializeInvitation, generateTemplateIdentifier, parseTemplate } from '@xo-cash/utils';
import { hermesHtlcTemplate } from './templates/htlc.js';
import { hermesIdentityTemplate } from './templates/identity.js';
import { hermesDropsClaimTemplate } from './templates/drops-claim.js';

/** Validate a template against the official XO template schema (throws with details). */
export function validateTemplate(t: unknown) {
  return parseTemplate(JSON.parse(JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))) as never);
}

/** The engine's identifier: hash of the *parsed* template (amount strings normalised). */
export const templateIdentifierOf = (t: unknown) => generateTemplateIdentifier(validateTemplate(t) as never);

/** Browser-safe (no engine): identifiers of the Hermes templates and a readable view of an invitation. */
export const HERMES_TEMPLATES = [hermesHtlcTemplate, hermesIdentityTemplate, hermesDropsClaimTemplate].map((t) => ({
  name: t.name,
  template: t,
  identifier: templateIdentifierOf(t),
}));

export interface InvitationView {
  invitationIdentifier: string;
  templateIdentifier: string;
  templateName?: string;
  pinned: boolean;
  action: string;
  commits: { commit: string; entity: string; role?: string; expires?: string; expired: boolean; variables: { id: string; role?: string; value: string }[]; inputs: number; outputs: number }[];
}

const show = (v: unknown) =>
  typeof v === 'bigint' ? `${v}` : v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Decode a shared invitation. The payload is untrusted data; the decoder validates every field type. */
export function describeInvitation(serialized: string, now = Date.now()): InvitationView {
  const inv = deserializeInvitation(serialized) as unknown as {
    invitationIdentifier: string;
    templateIdentifier: string;
    actionIdentifier: string;
    commits: { commitIdentifier: string; entityIdentifier: string; expiresAtTimestamp?: number; data?: { roleIdentifier?: string; variables?: { variableIdentifier: string; roleIdentifier?: string; value: unknown }[]; inputs?: unknown[]; outputs?: unknown[] } }[];
  };
  const known = HERMES_TEMPLATES.find((t) => t.identifier === inv.templateIdentifier);
  // An entity names its role in its first commit; later commits of the same entity inherit it.
  const roleOf = new Map<string, string>();
  for (const c of inv.commits) if (c.data?.roleIdentifier && !roleOf.has(c.entityIdentifier)) roleOf.set(c.entityIdentifier, c.data.roleIdentifier);
  return {
    invitationIdentifier: inv.invitationIdentifier,
    templateIdentifier: inv.templateIdentifier,
    templateName: known?.name,
    pinned: !!known,
    action: inv.actionIdentifier,
    commits: inv.commits.map((c) => ({
      commit: c.commitIdentifier,
      entity: `${c.entityIdentifier.slice(0, 16)}…`,
      role: c.data?.roleIdentifier ?? roleOf.get(c.entityIdentifier),
      expires: c.expiresAtTimestamp ? new Date(c.expiresAtTimestamp).toISOString() : undefined,
      expired: !!c.expiresAtTimestamp && c.expiresAtTimestamp < now,
      variables: (c.data?.variables ?? []).map((v) => ({ id: v.variableIdentifier, role: v.roleIdentifier, value: show(v.value) })),
      inputs: c.data?.inputs?.length ?? 0,
      outputs: c.data?.outputs?.length ?? 0,
    })),
  };
}

export type XoNetworkName = 'chipnet' | 'mainnet';

/**
 * Every reason not to sign this invitation: unknown / unpinned template, plus the XO engine's own
 * `listInvitationValidationIssues` (template id and action, field types, entity keys for the
 * network, commit and result signatures). Empty = valid for a pinned Hermes template. Loads the
 * engine lazily so the viewer stays light; nothing touches a wallet or the network.
 */
export async function listInvitationIssues(serialized: string, network: XoNetworkName = 'chipnet'): Promise<string[]> {
  const inv = deserializeInvitation(serialized) as unknown as { templateIdentifier: string };
  const known = HERMES_TEMPLATES.find((t) => t.identifier === inv.templateIdentifier);
  if (!known) return [`Template ${inv.templateIdentifier} is not a pinned Hermes template — do not sign.`];
  const { listInvitationValidationIssues, XO_SUPPORTED_NETWORKS } = await import('@xo-cash/engine');
  const issues = (listInvitationValidationIssues as unknown as (...a: unknown[]) => unknown[])(inv, validateTemplate(known.template), XO_SUPPORTED_NETWORKS[network]);
  return issues.map((e) => (e instanceof Error ? e.message : JSON.stringify(e)));
}
