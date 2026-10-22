/**
 * The standard card: a script object we ship, shown in a slot. Its data says
 * what it shows (a label, a big value, a title, a paragraph, facts, buttons,
 * a note about something else that changed); its code draws that in the
 * theme and turns a tap on a button into `changed('action', ...)` for
 * whoever shows it. Each card is its own object, made from this source with
 * its own data and kept by AbjectStore: nothing about it is special to Chat.
 *
 * This file holds the source, its manifest, the check every card's data
 * passes (cleanCardData), and the plain text a card reads as where nothing
 * can draw (the model's context, the terminal app, search).
 */

import type { AbjectManifest, InterfaceId } from '../core/types.js';
import { require as precondition } from '../core/contracts.js';

/** Icons the standard card draws. */
export const CARD_ICONS = ['cloud', 'sun', 'rain', 'check', 'star', 'bolt', 'leaf', 'heart'] as const;
export type CardIcon = typeof CARD_ICONS[number];

export interface CardFact { label: string; value: string }
/** A button: `say` sends those words as the person's; `open` opens an object by typeId. */
export interface CardAction { label: string; say?: string; open?: string; primary?: boolean }

/** What a standard card shows. */
export interface CardData {
  /** Small capitals line at the top ("SATURDAY · OCT 24"). */
  label?: string;
  /** Quiet text at the right of the label ("Silverdale, WA"). */
  aside?: string;
  /** done, info or caution: the label's colour. */
  tone?: 'done' | 'info' | 'caution';
  icon?: CardIcon;
  /** A big value ("57°") with up to two short lines beside it. */
  value?: string;
  valueCaption?: string[];
  title?: string;
  body?: string;
  facts?: CardFact[];
  actions?: CardAction[];
  /** Something else that happened, with an optional way to undo it. */
  notice?: { text: string; action?: CardAction };
}

const LIMITS = { short: 80, title: 120, body: 600, facts: 6, actions: 3, caption: 2 };

function text(raw: unknown, max: number, what: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  precondition(typeof raw === 'string', `card ${what} must be text`);
  const t = (raw as string).replace(/\s+/g, ' ').trim();
  precondition(t.length <= max, `card ${what} is at most ${max} characters`);
  return t || undefined;
}

function action(raw: unknown, what: string): CardAction {
  precondition(!!raw && typeof raw === 'object', `card ${what} must be an object`);
  const a = raw as Record<string, unknown>;
  const label = text(a.label, 40, `${what} label`);
  precondition(!!label, `card ${what} needs a label`);
  const say = text(a.say, 500, `${what} say`);
  const open = text(a.open, 300, `${what} open`);
  precondition(!!say || !!open, `card ${what} needs say (words to send) or open (a typeId)`);
  return { label: label!, ...(say ? { say } : {}), ...(open ? { open } : {}), ...(a.primary === true ? { primary: true } : {}) };
}

/**
 * The card data a model or an object asked for, checked and trimmed: short
 * text fields, a known icon, at most six facts and three buttons. Throws a
 * contract error on anything else.
 */
export function cleanCardData(raw: unknown): CardData {
  precondition(!!raw && typeof raw === 'object' && !Array.isArray(raw), 'a card is an object');
  const r = raw as Record<string, unknown>;
  const out: CardData = {};
  const set = <K extends keyof CardData>(key: K, value: CardData[K] | undefined) => { if (value !== undefined) out[key] = value; };
  set('label', text(r.label, LIMITS.short, 'label'));
  set('aside', text(r.aside, LIMITS.short, 'aside'));
  if (r.tone !== undefined) {
    precondition(r.tone === 'done' || r.tone === 'info' || r.tone === 'caution', 'card tone is done, info or caution');
    out.tone = r.tone as CardData['tone'];
  }
  if (r.icon !== undefined) {
    precondition((CARD_ICONS as readonly string[]).includes(r.icon as string), `card icon is one of ${CARD_ICONS.join(', ')}`);
    out.icon = r.icon as CardIcon;
  }
  set('value', text(r.value, 12, 'value'));
  if (r.valueCaption !== undefined) {
    precondition(Array.isArray(r.valueCaption) && r.valueCaption.length <= LIMITS.caption, `card valueCaption is up to ${LIMITS.caption} lines`);
    const lines = (r.valueCaption as unknown[]).map((l, i) => text(l, 40, `valueCaption ${i + 1}`)).filter((l): l is string => !!l);
    if (lines.length) out.valueCaption = lines;
  }
  set('title', text(r.title, LIMITS.title, 'title'));
  set('body', text(r.body, LIMITS.body, 'body'));
  if (r.facts !== undefined) {
    precondition(Array.isArray(r.facts) && r.facts.length <= LIMITS.facts, `card facts are up to ${LIMITS.facts}`);
    out.facts = (r.facts as unknown[]).map((f, i) => {
      precondition(!!f && typeof f === 'object', `card fact ${i + 1} is { label, value }`);
      const label = text((f as Record<string, unknown>).label, 32, `fact ${i + 1} label`);
      const value = text((f as Record<string, unknown>).value, 40, `fact ${i + 1} value`);
      precondition(!!label && !!value, `card fact ${i + 1} needs a label and a value`);
      return { label: label!, value: value! };
    });
  }
  if (r.actions !== undefined) {
    precondition(Array.isArray(r.actions) && r.actions.length <= LIMITS.actions, `card actions are up to ${LIMITS.actions}`);
    out.actions = (r.actions as unknown[]).map((a, i) => action(a, `action ${i + 1}`));
  }
  if (r.notice !== undefined) {
    precondition(!!r.notice && typeof r.notice === 'object', 'card notice is { text, action? }');
    const n = r.notice as Record<string, unknown>;
    const noticeText = text(n.text, 200, 'notice text');
    precondition(!!noticeText, 'card notice needs text');
    out.notice = { text: noticeText!, ...(n.action !== undefined ? { action: action(n.action, 'notice action') } : {}) };
  }
  precondition(!!(out.title || out.value || out.body || out.facts?.length), 'a card shows at least a title, a value, a body or facts');
  return out;
}

/** The card as plain text, for the model, the terminal app and search. */
export function cardText(card: CardData): string {
  const lines: string[] = [];
  const head = [card.label, card.aside].filter(Boolean).join(' · ');
  if (head) lines.push(head);
  if (card.value) lines.push([card.value, ...(card.valueCaption ?? [])].join(' · '));
  if (card.title) lines.push(card.title);
  if (card.body) lines.push(card.body);
  for (const f of card.facts ?? []) lines.push(`${f.label}: ${f.value}`);
  if (card.notice) lines.push(card.notice.text);
  const buttons = [...(card.actions ?? []), ...(card.notice?.action ? [card.notice.action] : [])].map(a => a.label);
  if (buttons.length) lines.push(`[${buttons.join('] [')}]`);
  return lines.join('\n');
}

/** A name for a card's object from its title ("Saturday forecast" → "SaturdayForecastCard"). */
export function cardName(card: CardData): string {
  const words = (card.title ?? card.label ?? card.value ?? 'Card').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5);
  const pascal = words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
  return `${pascal || 'Info'}Card`.slice(0, 48);
}

/** The manifest a standard card object carries. */
export function standardCardManifest(card: CardData): AbjectManifest {
  return {
    name: cardName(card),
    description: `A card: ${(card.title ?? card.label ?? card.value ?? 'information').slice(0, 120)}`,
    version: '1.0.0',
    interface: {
      id: 'abjects:standard-card' as InterfaceId,
      name: 'StandardCard',
      description: 'A card shown in a slot: render draws it, handleInput turns a tap into an action, getCard reads what it shows, setCard changes it.',
      methods: [
        { name: 'render', description: 'Draw the card at a width: { width, host } -> { commands, height }', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'handleInput', description: 'A click or key in the card, in its own coordinates', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'getCard', description: 'What the card shows (its data)', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'setCard', description: 'Change what the card shows: { card } with the same fields', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
      ],
    },
    tags: ['card'],
  };
}

/**
 * The standard card's code. It runs in the sandbox like any script object;
 * `host` (the slot) measures and wraps text for it.
 */
export const STANDARD_CARD_SOURCE = String.raw`({
  async render(msg) {
    const { width, host } = msg.payload;
    const card = this.data.card || {};
    const W = Math.max(220, Math.floor(width));
    const pad = 20;
    const inner = W - pad * 2;
    const cmds = [];
    const hits = [];
    const wrap = async (text, font, max) => text ? await this.call(host, 'wrapText', { text, font, maxWidth: max }) : [];
    const measure = async (text, font) => text ? await this.call(host, 'measureText', { text, font }) : 0;
    const txt = (x, y, text, font, fill, extra) => cmds.push({ type: 'text', params: Object.assign({ x, y, text, font, fill, baseline: 'middle' }, extra || {}) });
    const rule = (y) => cmds.push({ type: 'rect', params: { x: 0, y: Math.round(y), width: W, height: 1, fill: '$divider' } });

    const drawIcon = (icon, x, y, size) => {
      const s = size / 64;
      const at = (path) => cmds.push({ type: 'save', params: {} }, { type: 'translate', params: { x, y } }, { type: 'scale', params: { x: s, y: s } }, ...path, { type: 'restore', params: {} });
      const stroke = (path, color) => ({ type: 'path', params: { path, stroke: color, lineWidth: 2.5 / s > 4 ? 4 : 2.5, lineJoin: 'round', lineCap: 'round' } });
      const cloud = 'M 16 50 h 34 a 11 11 0 0 0 0 -22 a 15 15 0 0 0 -28 -4 a 12 12 0 0 0 -6 26 z';
      if (icon === 'cloud') at([stroke(cloud, '$textSecondary')]);
      else if (icon === 'rain') at([stroke(cloud, '$textSecondary'), stroke('M 22 56 l -3 6 M 32 56 l -3 6 M 42 56 l -3 6', '$statusInfo')]);
      else if (icon === 'sun') at([{ type: 'circle', params: { cx: 32, cy: 32, radius: 12, stroke: '$statusWarning', lineWidth: 2.5 } }, stroke('M 32 6 v 8 M 32 50 v 8 M 6 32 h 8 M 50 32 h 8 M 14 14 l 6 6 M 44 44 l 6 6 M 50 14 l -6 6 M 20 44 l -6 6', '$statusWarning')]);
      else if (icon === 'check') at([stroke('M 14 34 l 12 12 l 24 -26', '$statusSuccess')]);
      else if (icon === 'star') at([stroke('M 32 8 l 7 15 l 16 2 l -12 11 l 3 16 l -14 -8 l -14 8 l 3 -16 l -12 -11 l 16 -2 z', '$accentTertiary')]);
      else if (icon === 'bolt') at([stroke('M 36 6 l -18 30 h 14 l -4 22 l 18 -30 h -14 z', '$statusWarning')]);
      else if (icon === 'leaf') at([stroke('M 12 52 c 0 -26 18 -40 42 -40 c 0 26 -16 42 -42 40 z M 12 52 l 24 -24', '$statusSuccess')]);
      else if (icon === 'heart') at([stroke('M 32 54 c -18 -12 -26 -22 -26 -32 a 12 12 0 0 1 26 -6 a 12 12 0 0 1 26 6 c 0 10 -8 20 -26 32 z', '$accent')]);
    };

    const toneColor = card.tone === 'done' ? '$statusSuccess' : card.tone === 'caution' ? '$statusWarning' : '$textSecondary';

    const frame = cmds.length;
    cmds.push(null);
    let y = 18;

    if (card.label || card.aside) {
      let x = pad;
      if (card.tone === 'done') {
        cmds.push({ type: 'path', params: { path: 'M ' + (x) + ' ' + (y) + ' l 4 4 l 8 -8', stroke: '$statusSuccess', lineWidth: 2 } });
        x += 18;
      }
      if (card.label) txt(x, y, String(card.label).toUpperCase(), '500 12px $display', toneColor, { letterSpacing: '1.5px' });
      if (card.aside) txt(W - pad, y, card.aside, '13px $body', '$textMeta', { align: 'right' });
      y += 22;
    }

    if (card.value) {
      const valueFont = '500 64px $display';
      // Measured, but never narrower than the display face's figures run
      // (about 0.55em each), so the caption clears the value.
      const vw = Math.max(await measure(card.value, valueFont), String(card.value).length * 64 * 0.55);
      const top = y;
      txt(pad, top + 36, card.value, valueFont, '$textHeading');
      let cy = top + 26;
      (card.valueCaption || []).slice(0, 2).forEach((line, i) => {
        txt(pad + vw + 16, cy, line, i === 0 ? '17px $body' : '14px $body', i === 0 ? '$textPrimary' : '$textSecondary');
        cy += 22;
      });
      if (card.icon) drawIcon(card.icon, W - pad - 64, top + 8, 64);
      y = top + 82;
    } else if (card.icon && card.title) {
      drawIcon(card.icon, W - pad - 40, y, 40);
    }

    if (card.title) {
      const font = '500 26px $display';
      const lines = await wrap(card.title, font, inner - (card.icon && !card.value ? 52 : 0));
      for (const line of lines) { txt(pad, y + 16, line, font, '$textHeading'); y += 32; }
      y += 4;
    }

    if (card.body) {
      const font = '14px $body';
      for (const line of await wrap(card.body, font, inner)) { txt(pad, y + 10, line, font, '$textSecondary'); y += 21; }
      y += 6;
    }

    const facts = card.facts || [];
    if (facts.length) {
      y += 6;
      const cols = Math.min(3, facts.length);
      const cellW = W / cols;
      for (let i = 0; i < facts.length; i += cols) {
        rule(y);
        const row = facts.slice(i, i + cols);
        row.forEach((f, j) => {
          const x = j * cellW;
          if (j > 0) cmds.push({ type: 'rect', params: { x: Math.round(x), y: y, width: 1, height: 60, fill: '$divider' } });
          txt(x + pad, y + 20, String(f.label).toUpperCase(), '500 11px $display', '$textMeta', { letterSpacing: '1.2px', maxWidth: cellW - pad * 1.5 });
          txt(x + pad, y + 42, f.value, '18px $body', '$textHeading', { maxWidth: cellW - pad * 1.5 });
        });
        y += 60;
      }
    }

    const actions = card.actions || [];
    if (actions.length) {
      rule(y);
      y += 14;
      let x = pad;
      for (const a of actions) {
        const font = a.primary ? '700 14px $body' : '14px $body';
        const bw = Math.ceil(await measure(a.label, font)) + 36;
        if (x + bw > W - pad && x > pad) { x = pad; y += 54; }
        cmds.push({ type: 'rect', params: Object.assign({ x, y, width: bw, height: 44 },
          a.primary ? { fill: '$actionBg' } : { fill: '$buttonBg', stroke: '$buttonBorder' }) });
        txt(x + bw / 2, y + 22, a.label, font, a.primary ? '$actionText' : '$textPrimary', { align: 'center' });
        hits.push({ x, y, w: bw, h: 44, action: a.say ? { say: a.say } : { open: a.open } });
        x += bw + 10;
      }
      y += 58;
    }

    if (card.notice) {
      const font = '13px $body';
      const linkFont = '700 13px $body';
      const linkW = card.notice.action ? Math.ceil(await measure(card.notice.action.label, linkFont)) + 8 : 0;
      const lines = await wrap(card.notice.text, font, inner - 24 - (linkW ? linkW + 12 : 0));
      const h = Math.max(40, lines.length * 19 + 20);
      rule(y);
      cmds.push({ type: 'save', params: {} });
      cmds.push({ type: 'globalAlpha', params: { value: 0.1 } });
      cmds.push({ type: 'rect', params: { x: 0, y: y + 1, width: W, height: h - 1, fill: '$statusWarning' } });
      cmds.push({ type: 'restore', params: {} });
      cmds.push({ type: 'circle', params: { cx: pad + 7, cy: y + h / 2, radius: 6, stroke: '$statusWarning', lineWidth: 1.4 } });
      lines.forEach((line, i) => txt(pad + 22, y + h / 2 - (lines.length - 1) * 9.5 + i * 19, line, font, '$statusWarning'));
      if (card.notice.action) {
        txt(W - pad, y + h / 2, card.notice.action.label, linkFont, '$statusWarning', { align: 'right' });
        cmds.push({ type: 'rect', params: { x: W - pad - linkW + 4, y: y + h / 2 + 8, width: linkW - 4, height: 1, fill: '$statusWarning' } });
        const a = card.notice.action;
        hits.push({ x: W - pad - linkW, y: y + 4, w: linkW, h: h - 8, action: a.say ? { say: a.say } : { open: a.open } });
      }
      y += h;
    } else {
      y += 6;
    }

    const H = Math.ceil(y);
    cmds[frame] = { type: 'rect', params: { x: 0.5, y: 0.5, width: W - 1, height: H - 1, fill: '$buttonBg', stroke: '$divider' } };
    this.data.hits = hits;
    return { commands: cmds, height: H };
  },

  async handleInput(msg) {
    const { type, x, y } = msg.payload;
    if (type !== 'mousedown') return { consumed: false };
    const hit = (this.data.hits || []).find((h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
    if (!hit) return { consumed: false };
    this.changed('action', hit.action);
    return { consumed: true };
  },

  getCard() {
    return this.data.card || {};
  },

  async setCard(msg) {
    const next = msg.payload && msg.payload.card;
    if (!next || typeof next !== 'object') return false;
    this.data.card = next;
    await this.saveData();
    this.changed('redraw');
    return true;
  },
})`;

/**
 * How a writer of answers adds a card (Chat's replies, a goal's final
 * answer): one fenced block after the text, which Chat turns into a card.
 */
export const CARD_GUIDANCE = `Cards: when the answer has a shape the person will glance at (a forecast, something you made or changed, a few key figures), show it as a card as well as saying it. Add one fenced block after your text:

\`\`\`card
{"label": "Saturday · Oct 24", "aside": "Silverdale, WA", "icon": "cloud", "value": "57°", "valueCaption": ["Overcast", "Low of 41°"], "facts": [{"label": "Chance of rain", "value": "27%"}, {"label": "Wind", "value": "Light, 5 mph"}]}
\`\`\`

Fields (all optional; give at least a title, value, body or facts): label (a short heading line), aside (quiet text beside it), tone ("done" for something finished, "caution" for something to watch), icon (${CARD_ICONS.join(', ')}), value (a big figure, a few characters) with valueCaption (up to two short lines), title, body (a short paragraph), facts (up to six { label, value }), actions (up to three buttons { label, say } where say is what the person would type next, e.g. "Use DeepSeek V4.1 Flash in this chat", with primary: true on the main one), notice ({ text, action? }: something else that happened, such as a setting you changed, with an action that undoes it). Keep the text above the card to a sentence or two; the card carries the details. Plain answers stay plain text.`;
