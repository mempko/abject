/**
 * FormWidget — a schema-driven form composed from existing input widgets.
 *
 * A VBoxLayout subclass that OWNS its children: given a JSON-schema-shaped
 * `schema` ({ properties, required }), it spawns a label + input pair per
 * property, a status line, and a submit button, wires their events, and
 * validates on submit. One `create` spec turns any JSON schema (or a manifest
 * method's parameter list mapped to properties) into working UI.
 *
 * Field mapping: enum → select; boolean → checkbox; number/integer →
 * textInput validated numerically on submit; everything else → textInput
 * (masked automatically when the property name looks like a credential).
 *
 * Events (via changed()):
 *   submit        — JSON of the typed values (numbers as numbers, booleans as
 *                   booleans), emitted only after validation passes
 *   contentHeight — number  natural height of the whole form, reported once
 *                   built (same owner pattern as contentBlock/goalProgress)
 *
 * Methods: getValues → current typed values; setValues { values } fills
 * fields and the cache.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request } from '../../core/message.js';
import { VBoxLayout } from './vbox-layout.js';
import { LayoutConfig, LAYOUT_INTERFACE_DECL } from './layout-abject.js';
import { WidgetAbject } from './widget-abject.js';
import { LabelWidget } from './label-widget.js';
import { TextInputWidget } from './text-input-widget.js';
import { CheckboxWidget } from './checkbox-widget.js';
import { SelectWidget } from './select-widget.js';
import { ButtonWidget } from './button-widget.js';

export interface FormFieldSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  default?: unknown;
}

export interface FormSchema {
  properties: Record<string, FormFieldSchema>;
  required?: string[];
}

export interface FormWidgetConfig extends LayoutConfig {
  schema?: FormSchema;
  submitLabel?: string;
}

const FIELD_LABEL_HEIGHT = 16;
const FIELD_HEIGHT = 32;
const STATUS_HEIGHT = 18;
const BUTTON_HEIGHT = 32;
const BUTTON_WIDTH = 120;
const SECRET_NAME = /password|secret|token|key/i;

interface FieldRuntime {
  name: string;
  schema: FormFieldSchema;
  kind: 'text' | 'number' | 'boolean' | 'enum';
  widgetId: AbjectId;
}

export class FormWidget extends VBoxLayout {
  private schema: FormSchema;
  private submitLabel: string;
  private fields: FieldRuntime[] = [];
  private values: Record<string, unknown> = {};
  private statusLabelId?: AbjectId;
  private submitButtonId?: AbjectId;
  private spawnedChildren: WidgetAbject[] = [];

  constructor(config: FormWidgetConfig) {
    super({ ...config, margins: config.margins ?? { top: 8, right: 8, bottom: 8, left: 8 }, spacing: config.spacing ?? 6 });
    this.schema = config.schema ?? { properties: {} };
    this.submitLabel = config.submitLabel ?? 'Submit';

    // The VBoxLayout constructor stamps a layout manifest; re-stamp as a form.
    (this as unknown as { manifest: unknown }).manifest = {
      name: 'FormWidget',
      description: 'Schema-driven form: labeled inputs, validation, and a submit button from one spec',
      version: '1.0.0',
      interface: LAYOUT_INTERFACE_DECL,
      requiredCapabilities: [],
      providedCapabilities: [],
      tags: ['widget', 'form'],
    };

    // Seed the value cache from schema defaults.
    for (const [name, field] of Object.entries(this.schema.properties)) {
      if (field.default !== undefined) this.values[name] = field.default;
      else if (this.fieldKind(name, field) === 'boolean') this.values[name] = false;
    }

    // Wrap the layout's changed handler: keep its expanded/visibility behavior,
    // then layer the form's field-event handling on top.
    const baseChanged = this.handlers.get('changed');
    this.on('changed', async (msg: AbjectMessage) => {
      if (baseChanged) await baseChanged(msg);
      await this.onChildChanged(msg);
    });

    this.on('getValues', async () => this.typedValues());

    this.on('setValues', async (msg: AbjectMessage) => {
      const { values } = msg.payload as { values: Record<string, unknown> };
      if (!values) return false;
      await this.fillValues(values);
      return true;
    });
  }

  private fieldKind(name: string, field: FormFieldSchema): FieldRuntime['kind'] {
    if (field.enum && field.enum.length > 0) return 'enum';
    if (field.type === 'boolean') return 'boolean';
    if (field.type === 'number' || field.type === 'integer') return 'number';
    return 'text';
  }

  // ── Building ──────────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    await super.onInit();

    const base = { uiServerId: this.uiServerId, theme: this.theme, ownerId: this.ownerId };
    const rect = { x: 0, y: 0, width: 0, height: 0 };
    const addSpecs: Array<{ widgetId: AbjectId; h: number; hPolicy?: string; wFixed?: number; align?: string }> = [];

    for (const [name, field] of Object.entries(this.schema.properties)) {
      const kind = this.fieldKind(name, field);
      const required = this.schema.required?.includes(name) ?? false;
      const title = (field.title ?? name) + (required ? ' *' : '');

      // Boolean checkboxes carry their own label; other kinds get one above.
      if (kind !== 'boolean') {
        const label = new LabelWidget({
          type: 'label', rect, text: title,
          style: { fontSize: 11, color: this.theme.textSecondary },
          ...base,
        });
        await label.init(this.bus, this.id);
        this.spawnedChildren.push(label);
        addSpecs.push({ widgetId: label.id, h: FIELD_LABEL_HEIGHT });
      }

      let input: WidgetAbject;
      if (kind === 'enum') {
        const options = (field.enum ?? []).map(String);
        const defIdx = field.default !== undefined ? options.indexOf(String(field.default)) : -1;
        input = new SelectWidget({
          type: 'select', rect, options,
          selectedIndex: defIdx >= 0 ? defIdx : 0,
          ...base,
        });
        if (this.values[name] === undefined && options.length > 0) {
          this.values[name] = field.enum![defIdx >= 0 ? defIdx : 0];
        }
      } else if (kind === 'boolean') {
        input = new CheckboxWidget({
          type: 'checkbox', rect, text: title,
          checked: this.values[name] === true,
          ...base,
        });
      } else {
        input = new TextInputWidget({
          type: 'textInput', rect,
          text: this.values[name] !== undefined ? String(this.values[name]) : '',
          placeholder: field.description ?? (kind === 'number' ? '0' : ''),
          masked: SECRET_NAME.test(name),
          ...base,
        });
      }
      await input.init(this.bus, this.id);
      this.spawnedChildren.push(input);
      this.fields.push({ name, schema: field, kind, widgetId: input.id });
      addSpecs.push({ widgetId: input.id, h: FIELD_HEIGHT });
    }

    // Status line (validation feedback), then the submit button.
    const status = new LabelWidget({
      type: 'label', rect, text: '',
      style: { fontSize: 11, color: this.theme.statusError },
      ...base,
    });
    await status.init(this.bus, this.id);
    this.spawnedChildren.push(status);
    this.statusLabelId = status.id;
    addSpecs.push({ widgetId: status.id, h: STATUS_HEIGHT });

    const submit = new ButtonWidget({
      type: 'button', rect, text: this.submitLabel, ...base,
    });
    await submit.init(this.bus, this.id);
    this.spawnedChildren.push(submit);
    this.submitButtonId = submit.id;
    addSpecs.push({ widgetId: submit.id, h: BUTTON_HEIGHT, hPolicy: 'fixed', wFixed: BUTTON_WIDTH, align: 'right' });

    // Route through our own addLayoutChild handler (fire-and-forget, mailbox
    // serial) so dependents, relayout, and window detach all happen exactly as
    // they would for externally added children.
    for (const spec of addSpecs) {
      this.send(request(this.id, this.id, 'addLayoutChild', {
        widgetId: spec.widgetId,
        sizePolicy: {
          vertical: 'fixed',
          horizontal: spec.hPolicy ?? 'expanding',
        },
        preferredSize: spec.wFixed !== undefined
          ? { width: spec.wFixed, height: spec.h }
          : { height: spec.h },
        alignment: spec.align,
      }));
    }

    // Report the natural height so owners size the layout slot with the same
    // contentHeight pattern contentBlock and goalProgress use.
    this.changed('contentHeight', this.naturalHeight(addSpecs.map(s => s.h)));
  }

  private naturalHeight(childHeights: number[]): number {
    const content = childHeights.reduce((a, b) => a + b, 0);
    const gaps = Math.max(0, childHeights.length - 1) * this.spacing;
    return content + gaps + this.margins.top + this.margins.bottom;
  }

  // ── Values / validation ───────────────────────────────────────────

  private async onChildChanged(msg: AbjectMessage): Promise<void> {
    const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
    const from = msg.routing.from;

    if (from === this.submitButtonId && aspect === 'click') {
      await this.trySubmit();
      return;
    }

    const field = this.fields.find(f => f.widgetId === from);
    if (!field) return;

    if (aspect === 'change') {
      if (field.kind === 'boolean') {
        this.values[field.name] = value === 'true' || value === true;
      } else if (field.kind === 'enum') {
        // Map the string back to the original enum member when numeric.
        const match = (field.schema.enum ?? []).find(e => String(e) === String(value));
        this.values[field.name] = match ?? value;
      } else {
        this.values[field.name] = value;
      }
      return;
    }

    // Enter in any text field submits the form.
    if (aspect === 'submit') {
      this.values[field.name] = value;
      await this.trySubmit();
    }
  }

  /** Current values with numbers and booleans as their proper types. */
  private typedValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of this.fields) {
      const raw = this.values[field.name];
      if (raw === undefined || raw === '') continue;
      if (field.kind === 'number') {
        const n = Number(raw);
        out[field.name] = Number.isNaN(n) ? raw : n;
      } else if (field.kind === 'boolean') {
        out[field.name] = raw === true || raw === 'true';
      } else {
        out[field.name] = raw;
      }
    }
    return out;
  }

  /** Validate; on success emit `submit` with the typed payload. */
  private async trySubmit(): Promise<void> {
    for (const name of this.schema.required ?? []) {
      const v = this.values[name];
      if (v === undefined || v === '') {
        await this.setStatus(`${this.schema.properties[name]?.title ?? name} is required`);
        return;
      }
    }
    for (const field of this.fields) {
      if (field.kind !== 'number') continue;
      const raw = this.values[field.name];
      if (raw === undefined || raw === '') continue;
      if (Number.isNaN(Number(raw))) {
        await this.setStatus(`${field.schema.title ?? field.name} must be a number`);
        return;
      }
    }
    await this.setStatus('');
    this.changed('submit', JSON.stringify(this.typedValues()));
  }

  private async setStatus(text: string): Promise<void> {
    if (!this.statusLabelId) return;
    try {
      await this.request(request(this.id, this.statusLabelId, 'update', { text }));
    } catch { /* label may be gone */ }
  }

  private async fillValues(values: Record<string, unknown>): Promise<void> {
    for (const field of this.fields) {
      if (!(field.name in values)) continue;
      const v = values[field.name];
      this.values[field.name] = v;
      try {
        if (field.kind === 'boolean') {
          await this.request(request(this.id, field.widgetId, 'update', { checked: v === true || v === 'true' }));
        } else if (field.kind === 'enum') {
          const options = (field.schema.enum ?? []).map(String);
          const idx = options.indexOf(String(v));
          if (idx >= 0) {
            await this.request(request(this.id, field.widgetId, 'update', { selectedIndex: idx }));
          }
        } else {
          await this.request(request(this.id, field.widgetId, 'update', { text: v === undefined ? '' : String(v) }));
        }
      } catch { /* widget may be gone */ }
    }
  }

  protected override getWidgetValue(): string {
    return JSON.stringify(this.typedValues());
  }
}
