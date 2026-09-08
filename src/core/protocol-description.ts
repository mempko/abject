import type { AbjectManifest, TypeDeclaration } from './types.js';
/** Describe a receiver's extension messages for Ask and introspection. No dispatch or state lives here. */
export function describeMessages(manifest: AbjectManifest, methods: Array<{ name: string; description: string; parameters?: Record<string, TypeDeclaration> }>): void {
  for (const method of methods) {
    if (manifest.interface.methods.some(m => m.name === method.name)) continue;
    manifest.interface.methods.push({ name: method.name, description: method.description,
      parameters: Object.entries(method.parameters ?? {}).map(([key, type]) => ({ name: key.replace(/\?$/, ''), description: key.replace(/\?$/, ''), type, optional: key.endsWith('?') })),
      returns: { kind: 'object', properties: {} },
    });
  }
}
export const protocolText: TypeDeclaration = { kind: 'primitive', primitive: 'string' };
export const protocolNumber: TypeDeclaration = { kind: 'primitive', primitive: 'number' };
export const protocolObject: TypeDeclaration = { kind: 'object', properties: {} };
