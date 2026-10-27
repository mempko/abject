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
import { request, event } from '../core/message.js';
import { Sandbox } from '../core/sandbox.js';
import { Log } from '../core/timed-log.js';
import { UndoHistories, UndoRefused, UNDO_EVENTS, undoMethods, sameValue, type UndoAction, type UndoStep } from '../core/undo.js';

const log = new Log('TriggerManager');

const TRIGGER_INTERFACE: InterfaceId = 'abjects:trigger-manager';
const STORAGE_KEY = 'trigger-manager:rules';
/** A filter or template is one small expression run on every matching event. */
const EXPRESSION_SLICE_MS = 250;
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

/**
 * One undoable change to the rules, as the caller made it. A rule is kept
 * whole so undo puts it back under its own id; firing stats are not part of
 * what a step compares, since they change in the background.
 */
type RuleStep =
  | { kind: 'add'; rule: TriggerRule }
  | { kind: 'remove'; rule: TriggerRule }
  | { kind: 'enabled'; ruleId: string; before: boolean; after: boolean };

/** What a person defines about a rule (not its firing stats), for "changed since". */
function ruleDefinition(rule: TriggerRule): unknown {
  return {
    name: rule.name, sourceName: rule.sourceName, aspect: rule.aspect, filter: rule.filter ?? null,
    action: rule.action, enabled: rule.enabled,
  };
}

export class TriggerManager extends Abject {
  private storageId?: AbjectId;
  private rules = new Map<string, TriggerRule>();
  /** Each rule's sandbox and its compiled expressions, made on first use. */
  private expressions = new Map<string, { sandbox: Sandbox; filter?: number; payloadTemplate?: number }>();
  private ruleCounter = 0;

  /** Resolved + subscribed source objects: name -> id and id -> name. */
  private sourceIds = new Map<string, AbjectId>();
  private sourceNamesById = new Map<AbjectId, string>();
  /** Resolved target cache; cleared per-name on send failure. */
  private targetIds = new Map<string, AbjectId>();
  /** Each caller's rule changes, for undo (in memory: the rules are small). */
  private undo = new UndoHistories<RuleStep>({ mergeMs: 0, maxSteps: 50 });

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
            ...undoMethods('your last rule change: an added rule is removed, a removed rule comes back under its own id, an enable or disable is reversed'),
          ],
          events: [
            ...UNDO_EVENTS,
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
        const problem = TriggerManager.expressionProblem(filter);
        precondition(problem === undefined, `filter rejected: ${problem ?? ''}`);
      }
      if (action.payloadTemplate) {
        const problem = TriggerManager.expressionProblem(action.payloadTemplate);
        precondition(problem === undefined, `payloadTemplate rejected: ${problem ?? ''}`);
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
      await this.recordStep(msg.routing.from, `Add rule ${rule.name}`, { kind: 'add', rule: structuredClone(rule) });
      return { triggerId: id };
    });

    this.on('removeTrigger', async (msg: AbjectMessage) => {
      const { triggerId } = msg.payload as { triggerId: string };
      const rule = this.rules.get(triggerId);
      const deleted = await this.dropRule(triggerId);
      if (rule && deleted) {
        await this.recordStep(msg.routing.from, `Delete rule ${rule.name}`, { kind: 'remove', rule: structuredClone(rule) });
      }
      return deleted;
    });

    this.on('listTriggers', async () => {
      return [...this.rules.values()];
    });

    this.on('enableTrigger', async (msg: AbjectMessage) => {
      const { triggerId } = msg.payload as { triggerId: string };
      return this.setEnabledBy(msg.routing.from, triggerId, true);
    });

    this.on('disableTrigger', async (msg: AbjectMessage) => {
      const { triggerId } = msg.payload as { triggerId: string };
      return this.setEnabledBy(msg.routing.from, triggerId, false);
    });

    // Each caller undoes its own rule changes, newest first.
    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) => this.undo.state(await this.undoCallerKey(msg.routing.from)));

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
  // Rule changes + undo
  // ═══════════════════════════════════════════════════════════════════

  /** Forget a rule and its compiled expressions; whether it existed. */
  private async dropRule(triggerId: string): Promise<boolean> {
    const deleted = this.rules.delete(triggerId);
    this.dropExpressions(triggerId);
    if (deleted) {
      await this.persistToStorage();
      this.changed('triggerRemoved', { triggerId });
      log.info(`Removed trigger ${triggerId}`);
    }
    return deleted;
  }

  /** Put a rule back whole, under its own id. */
  private async putRule(rule: TriggerRule): Promise<void> {
    precondition(!this.rules.has(rule.id), `putRule: '${rule.id}' is taken`);
    const restored = structuredClone(rule);
    this.rules.set(restored.id, restored);
    const n = Number(/^trig-(\d+)$/.exec(restored.id)?.[1] ?? 0);
    if (n > this.ruleCounter) this.ruleCounter = n;
    this.checkInvariants();
    await this.subscribeSource(restored.sourceName);
    await this.persistToStorage();
    this.changed('triggerAdded', { triggerId: restored.id, name: restored.name });
  }

  private async setEnabled(rule: TriggerRule, enabled: boolean): Promise<void> {
    rule.enabled = enabled;
    if (enabled) await this.subscribeSource(rule.sourceName);
    await this.persistToStorage();
    this.changed('triggerUpdated', { triggerId: rule.id });
  }

  private async setEnabledBy(callerId: AbjectId, triggerId: string, enabled: boolean): Promise<boolean> {
    const rule = this.rules.get(triggerId);
    if (!rule) return false;
    const before = rule.enabled;
    await this.setEnabled(rule, enabled);
    if (before !== enabled) {
      await this.recordStep(callerId, `${enabled ? 'Enable' : 'Disable'} rule ${rule.name}`,
        { kind: 'enabled', ruleId: rule.id, before, after: enabled });
    }
    return true;
  }

  private async recordStep(callerId: AbjectId, label: string, step: RuleStep): Promise<void> {
    const caller = await this.undoCallerKey(callerId);
    this.undo.for(caller).record(label, step);
    this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
  }

  private async undoFor(callerId: AbjectId, action: UndoAction): Promise<unknown> {
    const caller = await this.undoCallerKey(callerId);
    const history = this.undo.get(caller);
    if (!history) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
    const result = await history[action](step => this.applyStep(step, action));
    this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
    return result;
  }

  /**
   * Take a rule change back (undo) or make it again (redo). A rule that
   * changed since the step (renamed, toggled, removed or re-added by
   * someone else) is left alone and the step refused.
   */
  private async applyStep(step: UndoStep<RuleStep>, action: UndoAction): Promise<unknown> {
    const d = step.data;
    if (d.kind === 'enabled') {
      const rule = this.rules.get(d.ruleId);
      if (!rule) throw new UndoRefused(`The rule was removed since`);
      const [from, to] = action === 'undo' ? [d.after, d.before] : [d.before, d.after];
      if (rule.enabled !== from) throw new UndoRefused(`'${rule.name}' was ${rule.enabled ? 'enabled' : 'disabled'} again since`);
      await this.setEnabled(rule, to);
      return { triggerId: rule.id };
    }
    // Adding undone and removing redone both take the rule away; the other
    // two put it back.
    const takeAway = (d.kind === 'add') === (action === 'undo');
    const current = this.rules.get(d.rule.id);
    if (takeAway) {
      if (!current) throw new UndoRefused(`'${d.rule.name}' is gone already`);
      if (!sameValue(ruleDefinition(current), ruleDefinition(d.rule))) throw new UndoRefused(`'${d.rule.name}' changed since`);
      // Keep its stats as they are now, for when it comes back.
      d.rule = structuredClone(current);
      await this.dropRule(current.id);
    } else {
      if (current) throw new UndoRefused(`'${d.rule.name}' is back already`);
      await this.putRule(d.rule);
    }
    return { triggerId: d.rule.id };
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

  /** Why an expression would be refused, or undefined when it is fine. */
  private static expressionProblem(expression: string): string | undefined {
    try {
      Sandbox.checkSource(expression, 'expression', ['aspect', 'value']);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Evaluate a rule's filter or payload template over a copy of the event.
   * Each rule keeps one sandbox, compiled on first use; an expression must
   * answer at once.
   */
  private evaluate(rule: TriggerRule, which: 'filter' | 'payloadTemplate', aspect: string, value: unknown): unknown {
    const expression = which === 'filter' ? rule.filter : rule.action.payloadTemplate;
    precondition(typeof expression === 'string' && expression.length > 0, `${which} is set`);
    let entry = this.expressions.get(rule.id);
    if (!entry || entry.sandbox.stopped) {
      entry = { sandbox: new Sandbox({ filename: `trigger-${rule.id}.js`, sliceMs: EXPRESSION_SLICE_MS }) };
      this.expressions.set(rule.id, entry);
    }
    let fn = entry[which];
    if (fn === undefined) {
      fn = entry.sandbox.compileExpression(expression, ['aspect', 'value']);
      entry[which] = fn;
    }
    const outcome = entry.sandbox.invoke(fn, [aspect, value]);
    if (!outcome.sync) {
      outcome.promise.catch(() => { /* answered below */ });
      throw new Error(`${which} must give its answer at once, not a promise`);
    }
    return outcome.value;
  }

  private dropExpressions(ruleId: string): void {
    this.expressions.get(ruleId)?.sandbox.dispose('the trigger was removed');
    this.expressions.delete(ruleId);
  }

  protected override async onStop(): Promise<void> {
    for (const id of [...this.expressions.keys()]) this.dropExpressions(id);
    await super.onStop();
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
          const ok = this.evaluate(rule, 'filter', aspect, value);
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
          payload = this.evaluate(rule, 'payloadTemplate', aspect, value);
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
  await call(await dep('TriggerManager'), 'undo', {});  // takes back your last add, remove, enable or disable
  await call(await dep('TriggerManager'), 'redo', {});

### Semantics
- Sources and targets are registered object NAMES. Rules survive object respawns: ids are re-resolved automatically.
- A rule whose source does not exist yet stays dormant and attaches when the object registers.
- \`filter\` and \`payloadTemplate\` are synchronous JS expressions evaluated in a sandbox with \`aspect\` (string) and \`value\` (a copy of the event payload) in scope. A throwing filter counts as no match; a throwing template records lastError. Each evaluation may run for 250 ms.
- Rules persist to Storage and reload on startup.
- \`undo\` and \`redo\` act on your own rule changes for this session; a removed rule comes back under its own id. A rule changed since is left alone and the undo answers { ok: false, reason }.
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
