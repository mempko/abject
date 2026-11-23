/**
 * Permission modes and grants: the pure part of the design in
 * docs/design/permission-modes.html. PermissionBroker owns every grant; this
 * module only holds the vocabulary (modes, presets, grants, receipts) and the
 * attenuation arithmetic, so the broker, the chat window and the tests agree
 * on one definition.
 *
 * A mode is two axes plus a flag:
 *  - reach: how far the holder's tools go without asking (the AutonomyLevel
 *    order, ask < read < edit < full);
 *  - beyond: what happens past reach (deny < ask < allow);
 *  - readOnly: plan mode, read-only exploration until the person approves.
 *
 * Floors (protected paths, dangerous commands, deny rules, project trust and
 * autonomy, the workspace access ceiling) are never part of a grant: the
 * broker applies them on every decision.
 */

import { require } from './contracts.js';

export type Reach = 'ask' | 'read' | 'edit' | 'full';
export type Beyond = 'deny' | 'ask' | 'allow';

export const REACH_ORDER: readonly Reach[] = ['ask', 'read', 'edit', 'full'];
export const BEYOND_ORDER: readonly Beyond[] = ['deny', 'ask', 'allow'];

export interface PermissionMode {
  reach: Reach;
  beyond: Beyond;
  /** Plan mode: nothing may write while this is set. */
  readOnly: boolean;
}

export interface ModeCeiling {
  reach: Reach;
  beyond: Beyond;
}

export type PresetName = 'ask' | 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'unattended' | 'fullAccess';

export interface ModePreset {
  name: PresetName;
  label: string;
  description: string;
  mode: PermissionMode;
}

/** The named presets the person sees (§3.2). Order is weakest to strongest. */
export const MODE_PRESETS: readonly ModePreset[] = [
  { name: 'plan', label: 'Plan', description: 'Reads and plans; changes nothing until you approve the plan.',
    mode: { reach: 'read', beyond: 'ask', readOnly: true } },
  { name: 'manual', label: 'Manual', description: 'Reads freely, asks before every change.',
    mode: { reach: 'read', beyond: 'ask', readOnly: false } },
  { name: 'acceptEdits', label: 'Accept edits', description: 'Edits files in trusted projects, asks for anything else.',
    mode: { reach: 'edit', beyond: 'ask', readOnly: false } },
  { name: 'auto', label: 'Auto', description: 'Runs what the project allows, asks past that.',
    mode: { reach: 'full', beyond: 'ask', readOnly: false } },
  { name: 'unattended', label: 'Unattended', description: 'Never asks: does what its reach allows and denies the rest.',
    mode: { reach: 'edit', beyond: 'deny', readOnly: false } },
  { name: 'fullAccess', label: 'Full access', description: 'Never asks and allows past reach. Floors still apply.',
    mode: { reach: 'full', beyond: 'allow', readOnly: false } },
];

/** The behaviour of a caller with no grant: today's broker, ask every time. */
export const ASK_EVERY_TIME: PermissionMode = { reach: 'ask', beyond: 'ask', readOnly: false };

/**
 * Default workspace root grant: Auto for what it creates, ceiling Auto. Auto's
 * reach is `full`, so a new chat does what each project's own autonomy level
 * allows and asks past that, as the broker did before modes existed; a person
 * who wants new chats to ask more picks Manual in Settings → Grants.
 */
export const DEFAULT_ROOT_MODE: PermissionMode = { reach: 'full', beyond: 'ask', readOnly: false };
export const DEFAULT_ROOT_CEILING: ModeCeiling = { reach: 'full', beyond: 'ask' };
/** Default app/package grant (§8): Manual, ceiling Manual, may not pass on. */
export const DEFAULT_APP_MODE: PermissionMode = { reach: 'read', beyond: 'ask', readOnly: false };
export const DEFAULT_APP_CEILING: ModeCeiling = { reach: 'read', beyond: 'ask' };

/** Request types a grant may cover. `outward` only when listed (§12). */
export const GRANT_TYPES = ['shell', 'directory', 'clipboard', 'terminal', 'outward'] as const;
export const DEFAULT_GRANT_TYPES: readonly string[] = ['shell', 'directory', 'clipboard', 'terminal'];

export type DecisionBasis = 'grant' | 'rule' | 'session' | 'floor' | 'promptMode' | 'preapproved' | 'person';

/** What a receipt says about the grant that decided (§6.3). */
export interface GrantReceipt {
  id: string;
  mode: PermissionMode;
  /** Grant ids from the root down to the deciding grant. */
  chain: string[];
}

/** A grant as the broker stores it. The id is a holder-bound handle, not a bearer secret. */
export interface Grant {
  id: string;
  parent?: string;
  holder: string;
  holderLabel: string;
  taskId?: string;
  workspaceId: string;
  /** Durable key a chat grant is re-bound by when the chat respawns. */
  conversationId?: string;
  mode: PermissionMode;
  /**
   * Follow the parent's effective mode live instead of a mode of its own
   * (goal and task grants): raising or lowering the chat moves its running
   * work with it, still bounded by this grant's ceiling. Setting a mode on
   * the grant ends the inheritance.
   */
  inherit?: boolean;
  ceiling: ModeCeiling;
  types: string[];
  /** Path prefixes covered; null means wherever the project registry reaches. */
  roots: string[] | null;
  /** How many more levels this grant may pass on. */
  mayDerive: number;
  maySetMode: boolean;
  expiresAt?: number;
  revoked: boolean;
  createdAt: number;
}

export function reachRank(r: Reach): number {
  return REACH_ORDER.indexOf(r);
}

export function beyondRank(b: Beyond): number {
  return BEYOND_ORDER.indexOf(b);
}

export function isReach(v: unknown): v is Reach {
  return typeof v === 'string' && (REACH_ORDER as readonly string[]).includes(v);
}

export function isBeyond(v: unknown): v is Beyond {
  return typeof v === 'string' && (BEYOND_ORDER as readonly string[]).includes(v);
}

export function minReach(a: Reach, b: Reach): Reach {
  return reachRank(a) <= reachRank(b) ? a : b;
}

export function minBeyond(a: Beyond, b: Beyond): Beyond {
  return beyondRank(a) <= beyondRank(b) ? a : b;
}

/** The meet (greatest lower bound) of two modes. */
export function meetMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return { reach: minReach(a.reach, b.reach), beyond: minBeyond(a.beyond, b.beyond), readOnly: a.readOnly || b.readOnly };
}

export function modeWithin(mode: PermissionMode | ModeCeiling, ceiling: ModeCeiling): boolean {
  return reachRank(mode.reach) <= reachRank(ceiling.reach) && beyondRank(mode.beyond) <= beyondRank(ceiling.beyond);
}

/** `a` is no stronger than `b` on any axis (readOnly counts as weaker). */
export function modeAtMost(a: PermissionMode, b: PermissionMode): boolean {
  return modeWithin(a, b) && (a.readOnly || !b.readOnly);
}

export function sameMode(a: PermissionMode, b: PermissionMode): boolean {
  return a.reach === b.reach && a.beyond === b.beyond && a.readOnly === b.readOnly;
}

/** Parse an untrusted mode payload: a preset name or {reach, beyond, readOnly}. */
export function parseMode(input: unknown): PermissionMode | undefined {
  if (typeof input === 'string') return presetMode(input as PresetName);
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  if (typeof o.preset === 'string') {
    const base = presetMode(o.preset as PresetName);
    if (!base) return undefined;
    if (o.preset === 'unattended' && isReach(o.reach)) return { ...base, reach: o.reach };
    return base;
  }
  if (!isReach(o.reach) || !isBeyond(o.beyond)) return undefined;
  return { reach: o.reach, beyond: o.beyond, readOnly: o.readOnly === true };
}

export function parseCeiling(input: unknown): ModeCeiling | undefined {
  if (typeof input === 'string') {
    const m = presetMode(input as PresetName);
    return m ? { reach: m.reach, beyond: m.beyond } : undefined;
  }
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  return isReach(o.reach) && isBeyond(o.beyond) ? { reach: o.reach, beyond: o.beyond } : undefined;
}

export function presetMode(name: PresetName): PermissionMode | undefined {
  if (name === 'ask') return { ...ASK_EVERY_TIME };
  const p = MODE_PRESETS.find(x => x.name === name);
  return p ? { ...p.mode } : undefined;
}

/** The preset a mode matches, or undefined for a custom mode. Unattended matches any reach. */
export function presetOf(mode: PermissionMode): PresetName | undefined {
  if (sameMode(mode, ASK_EVERY_TIME)) return 'ask';
  for (const p of MODE_PRESETS) {
    if (p.name === 'unattended') {
      if (mode.beyond === 'deny' && !mode.readOnly) return 'unattended';
      continue;
    }
    if (sameMode(mode, p.mode)) return p.name;
  }
  return undefined;
}

export function modeLabel(mode: PermissionMode): string {
  const name = presetOf(mode);
  if (name === 'ask') return 'Ask every time';
  const p = MODE_PRESETS.find(x => x.name === name);
  if (p) return p.name === 'unattended' ? `Unattended (${mode.reach})` : p.label;
  return `${mode.readOnly ? 'plan, ' : ''}reach ${mode.reach}, beyond ${mode.beyond}`;
}

/** A child root is covered when it lies under one of the parent's roots. */
export function rootsWithin(child: string[] | null, parent: string[] | null): boolean {
  if (parent === null) return true;
  if (child === null) return false;
  return child.every(c => parent.some(p => isUnder(c, p)));
}

export function isUnder(path: string, root: string): boolean {
  const r = root.endsWith('/') ? root.slice(0, -1) : root;
  return path === r || path.startsWith(r + '/');
}

/**
 * Attenuation (rule 3): why `child` may not be derived from `parent`, or
 * undefined when it may. Never widens on any axis.
 */
export function attenuationViolation(
  child: Pick<Grant, 'mode' | 'ceiling' | 'types' | 'roots' | 'mayDerive' | 'maySetMode' | 'expiresAt' | 'workspaceId'>,
  parent: Grant,
): string | undefined {
  if (child.workspaceId !== parent.workspaceId) return 'a grant may not cross workspaces';
  if (!modeWithin(child.mode, parent.ceiling)) return 'mode exceeds the parent ceiling';
  if (!modeWithin(child.ceiling, parent.ceiling)) return 'ceiling exceeds the parent ceiling';
  // A root's mode is only the default it hands to what it creates; below the
  // root a plan-mode grant passes on nothing but plan mode.
  if (parent.parent !== undefined && parent.mode.readOnly && !child.mode.readOnly) return 'a plan-mode grant may only pass on plan mode';
  if (!child.types.every(t => parent.types.includes(t))) return 'types exceed the parent';
  if (!rootsWithin(child.roots, parent.roots)) return 'roots exceed the parent';
  if (parent.mayDerive <= 0) return 'the parent may not pass its grant on';
  if (child.mayDerive >= parent.mayDerive) return 'derive depth must shrink';
  if (child.maySetMode && !parent.maySetMode) return 'maySetMode exceeds the parent';
  if (parent.expiresAt !== undefined && (child.expiresAt === undefined || child.expiresAt > parent.expiresAt)) {
    return 'expiry exceeds the parent';
  }
  return undefined;
}

/** A ceiling read as the strongest mode it allows. */
export function ceilingMode(c: ModeCeiling): PermissionMode {
  return { reach: c.reach, beyond: c.beyond, readOnly: false };
}

/** Clamp a requested child shape into its parent: what a narrower derive would give. */
export function clampToParent(mode: PermissionMode, parent: Grant): PermissionMode {
  require(parent !== undefined, 'clampToParent needs a parent');
  const m: PermissionMode = {
    reach: minReach(mode.reach, parent.ceiling.reach),
    beyond: minBeyond(mode.beyond, parent.ceiling.beyond),
    readOnly: mode.readOnly || parent.mode.readOnly,
  };
  return m;
}
