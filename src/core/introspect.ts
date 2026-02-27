/**
 * Introspect protocol — allows any Abject to describe itself.
 *
 * Every Abject gets a built-in `abjects:introspect` interface with a `describe`
 * handler. Any object can ask any other object "what can you do?"
 */

import {
  AbjectManifest,
  InterfaceDeclaration,
  MethodDeclaration,
  EventDeclaration,
  TypeDeclaration,
} from './types.js';

export interface IntrospectResult {
  manifest: AbjectManifest;
  description: string;
}

/**
 * Introspect methods merged into every Abject's single interface.
 */
export const INTROSPECT_METHODS: MethodDeclaration[] = [
  {
    name: 'describe',
    description: 'Describe this object\'s capabilities in natural language',
    parameters: [],
    returns: { kind: 'reference', reference: 'IntrospectResult' },
  },
  {
    name: 'ask',
    description: 'Ask this object a question about its capabilities, usage, or behavior.',
    parameters: [
      {
        name: 'question',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'A question about this object',
      },
    ],
    returns: { kind: 'primitive', primitive: 'string' },
  },
  {
    name: 'getRegistry',
    description: 'Ask this object for the Registry ID. If unknown, asks its own parent (chains up).',
    parameters: [],
    returns: { kind: 'primitive', primitive: 'string' },
  },
];

/**
 * Introspect events merged into every Abject's single interface.
 */
export const INTROSPECT_EVENTS: EventDeclaration[] = [
  {
    name: 'childReady',
    description: 'Emitted when a child object finishes initialization',
    payload: { kind: 'object', properties: {
      childId: { kind: 'primitive', primitive: 'string' },
      name: { kind: 'primitive', primitive: 'string' },
    }},
  },
  {
    name: 'changed',
    description: 'Emitted when this object changes (Smalltalk changed: protocol)',
    payload: { kind: 'object', properties: {
      aspect: { kind: 'primitive', primitive: 'string' },
      value: { kind: 'primitive', primitive: 'undefined' },
    }},
  },
];

/**
 * Format a TypeDeclaration to a readable string.
 */
function formatType(type: TypeDeclaration): string {
  switch (type.kind) {
    case 'primitive':
      return type.primitive ?? 'unknown';
    case 'reference':
      return type.reference ?? 'unknown';
    case 'array':
      return type.elementType
        ? `Array<${formatType(type.elementType)}>`
        : 'Array<unknown>';
    case 'object': {
      if (!type.properties) return 'object';
      const props = Object.entries(type.properties)
        .map(([k, v]) => `${k}: ${formatType(v)}`)
        .join(', ');
      return `{ ${props} }`;
    }
    case 'union':
      return type.variants
        ? type.variants.map((v) => formatType(v)).join(' | ')
        : 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Format a method declaration to English.
 */
function formatMethod(m: MethodDeclaration): string {
  const params = m.parameters
    .map((p) => {
      const opt = p.optional ? '?' : '';
      return `${p.name}${opt}: ${formatType(p.type)}`;
    })
    .join(', ');
  const returns = m.returns ? ` -> ${formatType(m.returns)}` : '';
  const paramDescs = m.parameters
    .map((p) => `      ${p.name}: ${p.description}`)
    .join('\n');
  return `    ${m.name}(${params})${returns}\n      ${m.description}${paramDescs ? '\n' + paramDescs : ''}`;
}

/**
 * Format an event declaration to English with guidance for implementors.
 */
function formatEvent(e: EventDeclaration): string {
  return `    ${e.name} — ${e.description}. Payload: ${formatType(e.payload)}
      Your object MUST have a handler named '${e.name}' to receive these.`;
}

/**
 * Format an interface declaration to English.
 */
function formatInterface(iface: InterfaceDeclaration): string {
  const parts: string[] = [];
  parts.push(`  Interface: ${iface.id} — ${iface.description}`);

  if (iface.methods.length > 0) {
    parts.push('  Methods:');
    for (const m of iface.methods) {
      parts.push(formatMethod(m));
    }
  }

  if (iface.events && iface.events.length > 0) {
    parts.push('  Events (sent to your object as callbacks):');
    for (const e of iface.events) {
      parts.push(formatEvent(e));
    }
  }

  return parts.join('\n');
}

/** Meta-protocol method names that are filtered from descriptions */
const META_METHODS = new Set([
  'describe', 'ask', 'getRegistry', 'ping',
  'addDependent', 'removeDependent',
  'getSource', 'updateSource', 'probe',
]);

/**
 * Convert a manifest to a natural language description.
 *
 * The output includes the object's interface, methods with full signatures,
 * and events with explicit guidance that callers must implement handlers for them.
 * Meta-protocol methods (introspect, editable) are filtered out.
 */
export function formatManifestAsDescription(manifest: AbjectManifest): string {
  const parts: string[] = [];
  parts.push(`${manifest.name} (v${manifest.version}) — ${manifest.description}`);

  const iface = manifest.interface;

  // Filter out meta-protocol methods
  const userMethods = iface.methods.filter(m => !META_METHODS.has(m.name));
  // Filter out meta-protocol events
  const metaEvents = new Set(['childReady', 'changed', 'sourceUpdated']);
  const userEvents = (iface.events ?? []).filter(e => !metaEvents.has(e.name));

  if (userMethods.length > 0 || userEvents.length > 0) {
    parts.push('');
    parts.push(`  Interface: ${iface.id} — ${iface.description}`);

    if (userMethods.length > 0) {
      parts.push('  Methods:');
      for (const m of userMethods) {
        parts.push(formatMethod(m));
      }
    }

    if (userEvents.length > 0) {
      parts.push('  Events (sent to your object as callbacks):');
      for (const e of userEvents) {
        parts.push(formatEvent(e));
      }
    }
  }

  if (manifest.tags && manifest.tags.length > 0) {
    parts.push('');
    parts.push(`  Tags: ${manifest.tags.join(', ')}`);
  }

  return parts.join('\n');
}
