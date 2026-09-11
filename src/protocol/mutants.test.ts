/** Run: pnpm tsx --test src/protocol/mutants.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMutants } from './mutants.js';

const SRC = `
  const res = http({ method: 'GET', url: 'https://example.test/events' });
  const items = res.body.filter(e => e.kind === 'event');
  if (items.length > 0) { return items; }
  return [];
`;

/** The house dialect: a handler map, which is an EXPRESSION, not a statement
 *  list. This is what the invoker actually runs (`return (${source});`). */
const HANDLER_MAP = `{
  async listEvents(msg) {
    const res = await call('HttpClient', 'get', { url: 'https://example.test/events' });
    const items = JSON.parse(res.body).filter(e => e.kind === 'event');
    return items;
  }
}`;

test('generates deterministic, distinct mutants up to max', () => {
  const a = generateMutants(SRC, 12)!;
  const b = generateMutants(SRC, 12)!;
  assert.deepEqual(a.map(m => m.source), b.map(m => m.source));
  assert.ok(a.length >= 3, `expected >=3 mutants, got ${a.length}`);
  assert.equal(new Set(a.map(m => m.source)).size, a.length);
  for (const m of a) assert.notEqual(m.source, SRC);
});

test('respects max', () => {
  assert.ok(generateMutants(SRC, 2)!.length <= 2);
});

test('source with no mutation points yields an empty list, not null', () => {
  assert.deepEqual(generateMutants(`return 42;`, 12), []);
});

test('a handler map yields sites: it is parsed as the expression it is', () => {
  const m = generateMutants(HANDLER_MAP, 12);
  assert.notEqual(m, null);
  assert.deepEqual(m!.map(x => x.description).sort(), [
    `drop a .filter(...)`,
    `flip '===' to '!=='`,
  ]);
  for (const x of m!) assert.notEqual(x.source, HANDLER_MAP);
  // every mutant is still a parseable handler map
  for (const x of m!) assert.notEqual(generateMutants(x.source, 1), null);
});

test('a source that parses under no dialect returns null, not an empty list', () => {
  assert.equal(generateMutants(`{ async listEvents(msg) { return [ }`, 12), null);
  assert.equal(generateMutants(`function ( {`, 12), null);
});

test('comparison operators yield boundary mutants, not just negations', () => {
  const ms = generateMutants(`({ f(msg) { return msg.payload.n < 10; } })`, 20)!;
  assert.ok(ms.some(m => m.description.includes("boundary '<' to '<='")),
    JSON.stringify(ms.map(m => m.description)));
  assert.ok(ms.some(m => m.source.includes('<= 10') && !m.source.includes('>=')));
});

test('arithmetic plus and minus are swapped', () => {
  const ms = generateMutants(`({ f(msg) { return msg.payload.a + 1; } })`, 20)!;
  assert.ok(ms.some(m => m.source.includes('- 1')), JSON.stringify(ms.map(m => m.source)));
});

test('string concatenation is not mistaken for arithmetic', () => {
  const ms = generateMutants(`({ f(msg) { return 'HTTP ' + msg.payload.status; } })`, 20)!;
  assert.ok(!ms.some(m => m.description.includes("swap '+'")),
    JSON.stringify(ms.map(m => m.description)));
});
