/**
 * Introspect protocol — allows any Abject to describe itself.
 *
 * Every Abject gets a built-in `abjects:introspect` interface with a `describe`
 * handler. Any object can ask any other object "what can you do?"
 */

import {
  AbjectManifest,
  InterfaceId,
  InterfaceDeclaration,
  MethodDeclaration,
  EventDeclaration,
  TypeDeclaration,
} from './types.js';

export const INTROSPECT_INTERFACE_ID = 'abjects:introspect' as InterfaceId;

export interface IntrospectResult {
  manifest: AbjectManifest;
  description: string;
}

/**
 * The introspect interface declaration appended to every Abject's manifest.
 */
export const INTROSPECT_INTERFACE: InterfaceDeclaration = {
  id: INTROSPECT_INTERFACE_ID,
  name: 'Introspect',
  description: 'Self-description protocol — any object can describe its capabilities',
  methods: [
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
  ],
};

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

/**
 * Convert a manifest to a natural language description.
 *
 * The output includes all interfaces, methods with full signatures,
 * and events with explicit guidance that callers must implement handlers for them.
 */
export function formatManifestAsDescription(manifest: AbjectManifest): string {
  const parts: string[] = [];
  parts.push(`${manifest.name} (v${manifest.version}) — ${manifest.description}`);

  // Filter out introspect and editable interfaces — they're meta-protocols
  const userInterfaces = manifest.interfaces.filter(
    (i) => i.id !== INTROSPECT_INTERFACE_ID && i.id !== 'abjects:editable'
  );

  for (const iface of userInterfaces) {
    parts.push('');
    parts.push(formatInterface(iface));
  }

  if (manifest.tags && manifest.tags.length > 0) {
    parts.push('');
    parts.push(`  Tags: ${manifest.tags.join(', ')}`);
  }

  return parts.join('\n');
}
