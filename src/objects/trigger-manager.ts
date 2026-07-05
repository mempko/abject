/**
 * TriggerManager -- built-in per-workspace system object for declarative
 * event-to-action rules ("when X happens on A, send Y to B").
 *
 * This is the infrastructure replacement for one-off LLM-generated watcher
 * objects: rules are data, not code. Each rule names a source object, an
 * event aspect to match, an optional sandboxed filter expression, and an
 * action (target object, method, optional sandboxed payload template).
 * Sources and targets are addressed by registered NAME (durable across
 * respawns); AbjectIds are resolved through the workspace Registry at
 * subscribe/fire time and re-resolved when they go stale.
 *
 * Rules persist to the workspace Storage object and are resubscribed on
 * startup. A rule whose source does not exist yet stays dormant and attaches
 * automatically when the Registry announces the object.
 *
 * Complements Scheduler: Scheduler covers "at time T do X", TriggerManager
 * covers "when event E do X".
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, requireNonEmpty, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import { runSandboxed, validateCode } from '../core/sandbox.js';
import { Log } from '../core/timed-log.js';

const log = new Log('TriggerManager');

const TRIGGER_INTERFACE: InterfaceId = 'abjects:trigger-manager';
const STORAGE_KEY = 'trigger-manager:rules';
const FILTER_TIMEOUT_MS = 1_000;
const FIRE_TIMEOUT_MS = 15_000;

export interface TriggerAction {
  /** Registered name of the object to send to. */
  targetName: string;
  /** Method to invoke on the target. */
  method: string;
  /**
   * Optional JS expression producing the payload, evaluated in the sandbox
   * with `aspect` and `value` in scope. Default payload is { aspect, value }.
   */
  payloadTemplate?: string;
}

export interface TriggerRule {
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Registered name of the source object to watch. */
  sourceName: string;
  /** Event aspect to match; '*' matches every aspect. */
  aspect: string;
  /**
   * Optional JS boolean expression evaluated in the sandbox with `aspect`
   * and `value` in scope. The rule fires when it returns a truthy value.
   */
  filter?: string;
  action: TriggerAction;
  enabled: boolean;
  createdAt: number;
  /** ID of the object that created this rule. */
  owner: string;
  fireCount: number;
  lastFiredAt: number;
  lastError?: string;
}

export class TriggerManager extends Abject {
  private storageId?: AbjectId;
  private rules = new Map<string, TriggerRule>();
  private ruleCounter = 0;

  /** Resolved + subscribed source objects: name -> id and id -> name. */
  private sourceIds = new Map<string, AbjectId>();
  private sourceNamesById = new Map<AbjectId, string>();
  /** Resolved target cache; cleared per-name on send failure. */
  private targetIds = new Map<string, AbjectId>();

  constructor() {
    super({
      manifest: {
        name: 'TriggerManager',
        description:
          'The system rule engine for event-driven automation. Use this to wire objects together without ' +
          'writing code: "when object A emits event X, call method Y on object B". Rules are declarative ' +
          'data with an optional filter expression and payload template. Handles "whenever X changes do Y", ' +
          '"notify me when...", "react to errors by...", and all event-triggered automation. ' +
          'For time-based automation use Scheduler instead.',
        version: '1.0.0',
        interface: {
          id: TRIGGER_INTERFACE,
          name: 'TriggerManager',
          description: 'Declarative event-to-action trigger rules',
          methods: [
            {
              name: 'addTrigger',
              description: 'Register a new event-to-action rule',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable rule name', optional: true },
                { name: 'sourceName', type: { kind: 'primitive', primitive: 'string' }, description: 'Registered name of the object to watch' },
                { name: 'aspect', type: { kind: 'primitive', primitive: 'string' }, description: "Event aspect to match ('*' matches all)" },
                { name: 'filter', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional JS boolean expression with `aspect` and `value` in scope; rule fires when truthy', optional: true },
                { name: 'action', type: { kind: 'object', properties: {
                  targetName: { kind: 'primitive', primitive: 'string' },
                  method: { kind: 'primitive', primitive: 'string' },
                  payloadTemplate: { kind: 'primitive', primitive: 'string' },
                } }, description: 'Action: target object name, method, optional payload template expression' },
              ],
              returns: { kind: 'object', properties: { triggerId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'removeTrigger',
              description: 'Delete a trigger rule',
              parameters: [
                { name: 'triggerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Trigger ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listTriggers',
              description: 'Return all trigger rules with runtime stats (fireCount, lastFiredAt, lastError)',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'TriggerRule' } },
            },
            {
              name: 'enableTrigger',
              description: 'Enable a disabled trigger rule',
              parameters: [
                { name: 'triggerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Trigger ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'disableTrigger',
              description: 'Disable a trigger rule without removing it',
              parameters: [
                { name: 'triggerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Trigger ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
          events: [
            {
              name: 'triggerFired',
              description: 'A rule matched and its action was sent',
              payload: { kind: 'object', properties: {
                triggerId: { kind: 'primitive', primitive: 'string' },
                aspect: { kind: 'primitive', primitive: 'string' },
                targetName: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'triggerFailed',
              description: 'A rule matched but its filter, template, or action send failed',
              payload: { kind: 'object', properties: {
                triggerId: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'watcher', 'triggers'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadFromStorage();

    // Hear about newly registered objects so dormant rules can attach.
    const regId = await this.resolveRegistryId();
    if (regId) {
      this.send(request(this.id, regId, 'addDependent', {}));
    }

    await this.resubscribeAll();
    log.info(`Loaded ${this.rules.size} trigger rules`);
  }

  private setupHandlers(): void {
    this.on('addTrigger', async (msg: AbjectMessage) => {
      const { name, sourceName, aspect, filter, action } = msg.payload as {
        name?: string; sourceName: string; aspect: string; filter?: string;
        action: TriggerAction;
      };
      requireNonEmpty(sourceName, 'sourceName');
      requireNonEmpty(aspect, 'aspect');
      precondition(action !== undefined && action !== null, 'action is required');
      requireNonEmpty(action.targetName, 'action.targetName');
      requireNonEmpty(action.method, 'action.method');
      if (filter) {
        const check = validateCode(filter);
        precondition(check.valid, `filter contains blocked pattern: ${check.blocked ?? ''}`);
      }
      if (action.payloadTemplate) {
        const check = validateCode(action.payloadTemplate);
        precondition(check.valid, `payloadTemplate contains blocked pattern: ${check.blocked ?? ''}`);
      }

      // Deduplicate: an identical rule returns the existing id instead of
      // accumulating copies across sessions.
      const existing = this.findDuplicate(sourceName, aspect, filter, action);
      if (existing) {
        log.info(`Trigger already exists (${existing.id}), returning existing id`);
        return { triggerId: existing.id };
      }

      const id = `trig-${++this.ruleCounter}`;
      const rule: TriggerRule = {
        id,
        name: name ?? `${sourceName}.${aspect} to ${action.targetName}.${action.method}`,
        sourceName, aspect, filter, action,
        enabled: true,
        createdAt: Date.now(),
        owner: msg.routing.from as string,
        fireCount: 0,
        lastFiredAt: 0,
      };
      this.rules.set(id, rule);
      this.checkInvariants();
      await this.subscribeSource(sourceName);
      await this.persistToStorage();
      this.changed('triggerAdded', { triggerId: id, name: rule.name });
      log.info(`Added trigger "${rule.name}" -> ${id}`);
      return { triggerId: id };
    });

    this.on('removeTrigger', async (msg: AbjectMessage) => {
      const { triggerId } = msg.payload as { triggerId: string };
      const deleted = this.rules.delete(triggerId);
      if (deleted) {
        await this.persistToStorage();
        this.changed('triggerRemoved', { triggerId });
        log.info(`Removed trigger ${triggerId}`);
      }
      return deleted;
    });

    this.on('listTriggers', async () => {
      return [...this.rules.values()];
    });

    this.on('enableTrigger', async (msg: AbjectMessage) => {
      const { triggerId } = msg.payload as { triggerId: string };
      const rule = this.rules.get(triggerId);
      if (!rule) return false;
      rule.enabled = true;
      await this.subscribeSource(rule.sourceName);
      await this.persistToStorage();
      this.changed('triggerUpdated', { triggerId });
      return true;
    });

    this.on('disableTrigger', async (msg: AbjectMessage) => {
      const { triggerId } = msg.payload as { triggerId: string };
      const rule = this.rules.get(triggerId);
      if (!rule) return false;
      rule.enabled = false;
      await this.persistToStorage();
      this.changed('triggerUpdated', { triggerId });
      return true;
    });

    // Every source event arrives here: match against rules by sender + aspect.
    this.on('changed', async (msg: AbjectMessage) => {
      const from = msg.routing.from as AbjectId;
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };

      // Registry announcements: a dormant rule's source may now exist.
      if (aspect === 'objectRegistered') {
        const reg = value as { name?: string } | undefined;
        if (reg?.name && this.hasRuleForSource(reg.name) && !this.sourceIds.has(reg.name)) {
          await this.subscribeSource(reg.name);
        }
        return;
      }
      if (aspect === 'objectUnregistered') {
        // Drop stale caches; the rule stays and re-attaches on re-register.
        const reg = value as { objectId?: string } | undefined;
        if (reg?.objectId) this.dropStaleId(reg.objectId as AbjectId);
        return;
      }

      const sourceName = this.sourceNamesById.get(from);
      if (!sourceName) return;
      await this.fireMatching(sourceName, aspect, value);
    });

    // The bus tells us when an event bounced off a dead recipient: clear the
    // cached ids so the next resolution finds the respawned object.
    this.on('recipientGone', async (msg: AbjectMessage) => {
      const { recipient } = msg.payload as { recipient?: AbjectId };
      if (recipient) this.dropStaleId(recipient);
      return true;
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Matching + firing
  // ═══════════════════════════════════════════════════════════════════

  private hasRuleForSource(name: string): boolean {
    for (const rule of this.rules.values()) {
      if (rule.sourceName === name) return true;
    }
    return false;
  }

  private async fireMatching(sourceName: string, aspect: string, value: unknown): Promise<void> {
    let dirty = false;
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.sourceName !== sourceName) continue;
      if (rule.aspect !== '*' && rule.aspect !== aspect) continue;

      // Filter: a throwing or falsy filter means no match. Errors are
      // recorded on the rule, never propagated.
      if (rule.filter) {
        try {
          const ok = await runSandboxed(
            `return (${rule.filter});`,
            { aspect, value },
            { filename: `trigger-${rule.id}-filter.js`, timeout: FILTER_TIMEOUT_MS },
          );
          if (!ok) continue;
        } catch (err) {
          rule.lastError = `filter: ${err instanceof Error ? err.message : String(err)}`;
          this.changed('triggerFailed', { triggerId: rule.id, error: rule.lastError });
          dirty = true;
          continue;
        }
      }

      // Payload: template expression or the default { aspect, value }.
      let payload: unknown = { aspect, value };
      if (rule.action.payloadTemplate) {
        try {
          payload = await runSandboxed(
            `return (${rule.action.payloadTemplate});`,
            { aspect, value },
            { filename: `trigger-${rule.id}-payload.js`, timeout: FILTER_TIMEOUT_MS },
          );
        } catch (err) {
          rule.lastError = `payloadTemplate: ${err instanceof Error ? err.message : String(err)}`;
          this.changed('triggerFailed', { triggerId: rule.id, error: rule.lastError });
          dirty = true;
          continue;
        }
      }

      await this.fireAction(rule, aspect, payload);
      dirty = true;
    }
    if (dirty) await this.persistToStorage();
  }

  private async fireAction(rule: TriggerRule, aspect: string, payload: unknown): Promise<void> {
    const targetId = await this.resolveTarget(rule.action.targetName);
    if (!targetId) {
      rule.lastError = `target '${rule.action.targetName}' not found`;
      this.changed('triggerFailed', { triggerId: rule.id, error: rule.lastError });
      return;
    }
    try {
      await this.request(
        request(this.id, targetId, rule.action.method,
          (payload ?? {}) as Record<string, unknown>),
        FIRE_TIMEOUT_MS,
      );
      rule.fireCount += 1;
      rule.lastFiredAt = Date.now();
      rule.lastError = undefined;
      this.changed('triggerFired', {
        triggerId: rule.id, aspect, targetName: rule.action.targetName,
      });
      log.info(`Trigger "${rule.name}" fired -> ${rule.action.targetName}.${rule.action.method}`);
    } catch (err) {
      // Record and drop the cached target so the next fire re-resolves it
      // (the object may have been respawned under a new id).
      rule.lastError = err instanceof Error ? err.message : String(err);
      this.targetIds.delete(rule.action.targetName);
      this.changed('triggerFailed', { triggerId: rule.id, error: rule.lastError });
      log.warn(`Trigger "${rule.name}" action failed:`, rule.lastError);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Resolution + subscription
  // ═══════════════════════════════════════════════════════════════════

  private async subscribeSource(name: string): Promise<void> {
    if (this.sourceIds.has(name)) return;
    const id = await this.discoverDep(name);
    if (!id) {
      log.info(`Source '${name}' not yet registered; rule stays dormant`);
      return;
    }
    this.sourceIds.set(name, id);
    this.sourceNamesById.set(id, name);
    this.send(request(this.id, id, 'addDependent', {}));
    log.info(`Subscribed to source '${name}' (${id.slice(0, 8)})`);
  }

  private async resolveTarget(name: string): Promise<AbjectId | null> {
    const cached = this.targetIds.get(name);
    if (cached) return cached;
    const id = await this.discoverDep(name);
    if (id) this.targetIds.set(name, id);
    return id;
  }

  private async resubscribeAll(): Promise<void> {
    const names = new Set<string>();
    for (const rule of this.rules.values()) names.add(rule.sourceName);
    for (const name of names) {
      await this.subscribeSource(name);
    }
  }

  private dropStaleId(staleId: AbjectId): void {
    const sourceName = this.sourceNamesById.get(staleId);
    if (sourceName) {
      this.sourceNamesById.delete(staleId);
      this.sourceIds.delete(sourceName);
    }
    for (const [name, id] of this.targetIds) {
      if (id === staleId) this.targetIds.delete(name);
    }
  }

  private findDuplicate(
    sourceName: string, aspect: string, filter: string | undefined, action: TriggerAction,
  ): TriggerRule | undefined {
    for (const rule of this.rules.values()) {
      if (rule.sourceName === sourceName
          && rule.aspect === aspect
          && (rule.filter ?? '') === (filter ?? '')
          && rule.action.targetName === action.targetName
          && rule.action.method === action.method
          && (rule.action.payloadTemplate ?? '') === (action.payloadTemplate ?? '')) {
        return rule;
      }
    }
    return undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════════

  private async persistToStorage(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: STORAGE_KEY,
        value: { counter: this.ruleCounter, rules: [...this.rules.values()] },
      }));
    } catch (err) {
      log.warn('Failed to persist trigger rules:', err instanceof Error ? err.message : String(err));
    }
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.storageId) return;
    try {
      const data = await this.request<{ counter: number; rules: TriggerRule[] } | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY }),
      );
      if (data?.rules) {
        this.ruleCounter = data.counter ?? 0;
        for (const rule of data.rules) {
          this.rules.set(rule.id, rule);
        }
      }
    } catch (err) {
      log.warn('Failed to load trigger rules:', err instanceof Error ? err.message : String(err));
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.ruleCounter >= 0, 'ruleCounter must be non-negative');
    for (const rule of this.rules.values()) {
      invariant(rule.id.length > 0, 'every rule must have an id');
      invariant(rule.sourceName.length > 0, 'every rule must have a sourceName');
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## TriggerManager Usage Guide

Use TriggerManager for ALL event-driven automation: it wires existing objects together with declarative rules instead of new watcher code. Pick Scheduler when the trigger is a time; pick TriggerManager when the trigger is an event another object emits.

A rule reads: when \`sourceName\` emits \`aspect\` (and \`filter\` passes), send \`action.method\` to \`action.targetName\` with a payload built from \`action.payloadTemplate\`.

### Notify the user when a record lands in a collection

  const { triggerId } = await call(await dep('TriggerManager'), 'addTrigger', {
    name: 'New order toast',
    sourceName: 'CollectionStore',
    aspect: 'recordInserted',
    filter: 'value && value.collection === "orders"',
    action: {
      targetName: 'NotificationCenter',
      method: 'notify',
      payloadTemplate: '({ message: "New order: " + JSON.stringify(value.record), level: "info" })',
    },
  });

### Open a repair goal when an object reports errors

  await call(await dep('TriggerManager'), 'addTrigger', {
    name: 'Auto-repair broken objects',
    sourceName: 'HealthMonitor',
    aspect: 'objectDead',
    action: {
      targetName: 'GoalManager',
      method: 'createGoal',
      payloadTemplate: '({ title: "Repair dead object", description: "Investigate and repair the object reported dead: " + JSON.stringify(value) })',
    },
  });

### Mirror every event from one object to another

  await call(await dep('TriggerManager'), 'addTrigger', {
    sourceName: 'PriceTracker',
    aspect: '*',
    action: { targetName: 'Chat', method: 'addNotification' },
  });
  // With no payloadTemplate the target receives { aspect, value }.

### Manage rules

  const rules = await call(await dep('TriggerManager'), 'listTriggers', {});
  // rules: [{ id, name, sourceName, aspect, filter?, action, enabled, fireCount, lastFiredAt, lastError? }]
  await call(await dep('TriggerManager'), 'disableTrigger', { triggerId: 'trig-1' });
  await call(await dep('TriggerManager'), 'enableTrigger', { triggerId: 'trig-1' });
  await call(await dep('TriggerManager'), 'removeTrigger', { triggerId: 'trig-1' });

### Semantics
- Sources and targets are registered object NAMES. Rules survive object respawns: ids are re-resolved automatically.
- A rule whose source does not exist yet stays dormant and attaches when the object registers.
- \`filter\` and \`payloadTemplate\` are JS expressions evaluated in a sandbox with \`aspect\` (string) and \`value\` (the event payload) in scope. A throwing filter counts as no match; a throwing template records lastError. Both run with a 1s timeout.
- Rules persist to Storage and reload on startup.
- Emits \`triggerFired\` and \`triggerFailed\` events; subscribe with addDependent to observe rule activity.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);

    const rules = [...this.rules.values()];
    const enabled = rules.filter(r => r.enabled);
    prompt += `\n\n### Current Rules\n`;
    prompt += `${rules.length} total, ${enabled.length} enabled.\n`;
    for (const r of rules) {
      const status = r.enabled ? 'enabled' : 'disabled';
      const err = r.lastError ? `, lastError: ${r.lastError.slice(0, 60)}` : '';
      prompt += `- ${r.name}: ${r.sourceName}.${r.aspect} -> ${r.action.targetName}.${r.action.method} (${status}, ${r.fireCount} fires${err})\n`;
    }

    return this.askLlm(prompt, question, 'balanced');
  }
}

export const TRIGGER_MANAGER_ID = 'abjects:trigger-manager' as AbjectId;
