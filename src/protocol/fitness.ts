/**
 * Fitness -- the judge the object cannot edit.
 *
 * evaluate() decides whether a candidate source is fit to deploy. It never
 * calls an LLM and never touches the network: all I/O is served from
 * recorded cassettes through the caller-supplied Invoker. Checks run in
 * order -- replay, schema, relations, mutation -- and the first hard
 * failure short-circuits.
 */
import Ajv from 'ajv';
import { canonicalJson, sha256 } from './canonical.js';
import { HTTP_CASSETTE_METHOD, type Cassette, type CassetteStore } from './cassette.js';
import { generateMutants } from './mutants.js';
import type { MethodDeclaration } from '../core/types.js';

/** One recorded response, as the fitness gate hands it to an invoker's HTTP
 *  shim. `rawBody` is the response text verbatim -- the shim must return it
 *  unchanged, because HttpClient promises objects a raw string body. `body`
 *  is the same response already parsed, for invokers that want it. */
export interface HttpExchange { status: number; body: unknown; rawBody: string; }
export type HttpStub = (req: { method: string; url: string; body?: unknown }) => HttpExchange | undefined;
export type Invoker = (source: string, method: string,
                       args: Record<string, unknown>, http: HttpStub) => Promise<unknown>;

export interface CheckResult {
  check: 'replay' | 'schema' | 'relations' | 'mutation';
  pass: boolean;
  /** Whether the check judged any actual invocation outcome. A pass with
   *  `verified: false` is an honest "nothing here could be judged", and the
   *  mutation gate refuses to run when no baseline check verified anything --
   *  a loop over checks that cannot fail kills nothing and would report the
   *  candidate unfit for the evidence's failing. */
  verified: boolean;
  detail: string;
}
export interface Verdict { pass: boolean; checks: CheckResult[]; killRatio?: number; }
export interface FitnessEvidence { cassettes: CassetteStore; methods: MethodDeclaration[]; }
export interface FitnessOptions { maxMutants?: number; killThreshold?: number; }

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function stubFor(cassettes: CassetteStore): HttpStub {
  return req => {
    const hit = cassettes.matchRequest({ method: req.method, url: req.url, body: req.body });
    return hit
      ? { status: hit.response.status, body: hit.response.body, rawBody: hit.rawBody }
      : undefined;
  };
}

/** Cassettes the gate may replay as a METHOD call. '_http' cassettes are raw
 *  traffic the recorder captured on the object's behalf: they are stubs for
 *  the candidate's own outbound calls (see `stubFor`), not invocations any
 *  object has a handler for. Replaying them asks for a handler that cannot
 *  exist, which would brick every heal of an object that ever recorded. */
function replayable(ev: FitnessEvidence, method?: string): Cassette[] {
  const all = method === undefined ? ev.cassettes.all() : ev.cassettes.byMethod(method);
  return all.filter(c => c.method !== HTTP_CASSETTE_METHOD);
}

async function checkReplay(source: string, ev: FitnessEvidence, invoke: Invoker): Promise<CheckResult> {
  const all = replayable(ev);
  if (all.length === 0) {
    return { check: 'replay', pass: true, verified: false,
      detail: 'no method-attributed cassettes; nothing replayed (probe required by caller)' };
  }
  for (const c of all) {
    let out: unknown;
    try {
      out = await invoke(source, c.method, c.args, stubFor(ev.cassettes));
    } catch (err) {
      return { check: 'replay', pass: false, verified: true,
        detail: `${c.method}(${JSON.stringify(c.args)}) threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!deepEqual(out, c.parsedOutput)) {
      return { check: 'replay', pass: false, verified: true,
        detail: `${c.method}(${JSON.stringify(c.args)}) diverged from cassette recorded at ${c.recordedAt}` };
    }
  }
  return { check: 'replay', pass: true, verified: true, detail: `${all.length} cassette(s) reproduced` };
}

async function checkSchema(source: string, ev: FitnessEvidence, invoke: Invoker): Promise<CheckResult> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let anyValidated = false;
  for (const m of ev.methods) {
    if (!m.outputSchema) continue;
    const validate = ajv.compile(m.outputSchema);
    const probes = replayable(ev, m.name).map(c => c.args);
    if (probes.length === 0) probes.push({});
    let validatedCount = 0;
    let firstError: string | undefined;
    for (const args of probes) {
      let out: unknown;
      try {
        out = await invoke(source, m.name, args, stubFor(ev.cassettes));
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof Error ? err.message : String(err);
        }
        continue; // replay already judges throwing; schema judges shape of what returns
      }
      if (!validate(out)) {
        return { check: 'schema', pass: false, verified: true,
          detail: `${m.name}: ${ajv.errorsText(validate.errors)}` };
      }
      validatedCount++;
      anyValidated = true;
    }
    if (validatedCount === 0 && firstError) {
      return { check: 'schema', pass: false, verified: true,
        detail: `${m.name}: no output could be validated (all probes threw: ${firstError})` };
    }
  }
  if (!anyValidated) {
    return { check: 'schema', pass: true, verified: false, detail: 'no output schemas declared' };
  }
  return { check: 'schema', pass: true, verified: true, detail: 'all outputs validate' };
}

function fieldValue(el: unknown, field: string): unknown {
  return el !== null && typeof el === 'object'
    ? (el as Record<string, unknown>)[field] : undefined;
}

async function checkRelations(source: string, ev: FitnessEvidence, invoke: Invoker): Promise<CheckResult> {
  /** Methods whose relations nothing could be evaluated against: every probe
   *  threw, so the loop below judged nothing about them. Saying the relations
   *  hold would be a claim the evidence never supported. */
  const unverified: string[] = [];
  let anyDeclared = false;
  for (const m of ev.methods) {
    if (!m.relations?.length) continue;
    anyDeclared = true;
    const probes = replayable(ev, m.name).map(c => c.args);
    if (probes.length === 0) probes.push({});
    let evaluated = 0;
    for (const args of probes) {
      let out: unknown;
      try { out = await invoke(source, m.name, args, stubFor(ev.cassettes)); }
      catch { continue; } // throwing is replay's failure, not relations'
      evaluated++;
      for (const rel of m.relations) {
        const fail = (why: string): CheckResult =>
          ({ check: 'relations', pass: false, verified: true, detail: `${m.name} ${rel.kind}: ${why}` });
        switch (rel.kind) {
          case 'idempotent': {
            let again: unknown;
            try {
              again = await invoke(source, m.name, args, stubFor(ev.cassettes));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return fail(`two identical calls disagreed (second call threw: ${msg})`);
            }
            if (!deepEqual(out, again)) return fail('two identical calls disagreed');
            break;
          }
          case 'no-duplicates': {
            if (!Array.isArray(out)) return fail('output is not an array');
            for (let i = 0; i < out.length; i++)
              for (let j = i + 1; j < out.length; j++)
                if (deepEqual(out[i], out[j])) return fail(`elements ${i} and ${j} are equal`);
            break;
          }
          case 'sorted-by': {
            if (!Array.isArray(out)) return fail('output is not an array');
            if (!rel.field) return fail('sorted-by declared without a field');
            for (let i = 1; i < out.length; i++) {
              const a = fieldValue(out[i - 1], rel.field), b = fieldValue(out[i], rel.field);
              if (a === undefined || b === undefined) return fail(`element missing field '${rel.field}'`);
              const ok = typeof a === 'string' && typeof b === 'string'
                ? a.localeCompare(b) <= 0 : (a as number) <= (b as number);
              if (!ok) return fail(`not sorted at index ${i}`);
            }
            break;
          }
          case 'subset-on-tighter-filter': {
            if (!rel.field) return fail('declared without a field');
            const cs = replayable(ev, m.name)
              .filter(c => c.args[rel.field!] !== undefined);
            if (cs.length < 2) break; // insufficient cassettes: vacuous
            const sorted = [...cs].sort((a, b) => {
              const aVal = a.args[rel.field!], bVal = b.args[rel.field!];
              if (typeof aVal === 'number' && typeof bVal === 'number') return aVal - bVal;
              return String(aVal).localeCompare(String(bVal));
            });
            let loose: unknown, tight: unknown;
            try {
              loose = await invoke(source, m.name, sorted[0].args, stubFor(ev.cassettes));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return fail(`invocation threw during relation check: ${msg}`);
            }
            try {
              tight = await invoke(source, m.name, sorted[sorted.length - 1].args, stubFor(ev.cassettes));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return fail(`invocation threw during relation check: ${msg}`);
            }
            if (!Array.isArray(loose) || !Array.isArray(tight)) return fail('outputs are not arrays');
            for (const t of tight)
              if (!loose.some(l => deepEqual(l, t)))
                return fail('tighter filter returned an element the looser one lacks');
            break;
          }
          case 'non-empty-for-known-entity': {
            if (!m.entityRef) break; // vacuous without a declared entity
            if (!JSON.stringify(out ?? '').includes(m.entityRef))
              return fail(`'${m.entityRef}' absent from output`);
            break;
          }
        }
      }
    }
    if (evaluated === 0) unverified.push(m.name);
  }
  // Mirrors checkSchema's `validatedCount === 0` guard. Unlike schema, an
  // unverified pass (not a failure) keeps faith with `evaluate`'s no-evidence
  // path: the mutation gate still refuses to certify what nothing can kill.
  if (unverified.length > 0) {
    return { check: 'relations', pass: true, verified: false,
      detail: `relations unverified (no replayable cassettes for ${unverified.join(', ')})` };
  }
  if (!anyDeclared) {
    return { check: 'relations', pass: true, verified: false, detail: 'no relations declared' };
  }
  return { check: 'relations', pass: true, verified: true, detail: 'all declared relations hold' };
}

export async function evaluate(candidate: { source: string },
                               evidence: FitnessEvidence,
                               invoker: Invoker,
                               opts?: FitnessOptions): Promise<Verdict> {
  const checks: CheckResult[] = [];

  // No evidence at all. Every check below would then be a probe with invented
  // arguments against a candidate nothing has ever exercised: a declared
  // outputSchema would fail on the {} probe, and a handler map would be
  // mutation-tested with nothing able to kill a single mutant. Both are
  // verdicts about the EVIDENCE, not the candidate, so say so and pass —
  // an unverified pass, honestly labelled, beats a fabricated failure.
  if (evidence.cassettes.all().length === 0) {
    return { pass: true, checks: [
      await checkReplay(candidate.source, evidence, invoker), // vacuous: invokes nothing
      { check: 'schema', pass: true, verified: false, detail: 'no cassettes — schema unverified' },
      { check: 'relations', pass: true, verified: false, detail: 'no cassettes — relations unverified' },
      { check: 'mutation', pass: true, verified: false, detail: 'no cassettes — mutation gate requires evidence' },
    ] };
  }

  const replay = await checkReplay(candidate.source, evidence, invoker);
  checks.push(replay);
  if (!replay.pass) return { pass: false, checks };

  const schema = await checkSchema(candidate.source, evidence, invoker);
  checks.push(schema);
  if (!schema.pass) return { pass: false, checks };

  const relations = await checkRelations(candidate.source, evidence, invoker);
  checks.push(relations);
  if (!relations.pass) return { pass: false, checks };

  const maxMutants = opts?.maxMutants ?? 12;
  const killThreshold = opts?.killThreshold ?? 0.8;
  if (maxMutants === 0) {
    checks.push({ check: 'mutation', pass: true, verified: false, detail: 'skipped' });
    return { pass: true, checks };
  }
  // Mutation testing asks: could this evidence tell a broken copy from the
  // real thing? When no baseline check verified anything, the answer is
  // already known -- no check can kill a mutant, and running the loop anyway
  // would fail the candidate for the evidence's poverty. This is the state a
  // store reaches when the recorder has captured raw traffic but no method
  // calls have been attributed yet.
  if (!checks.some(c => c.verified)) {
    checks.push({ check: 'mutation', pass: true, verified: false,
      detail: 'no check can kill a mutant — evidence insufficient' });
    return { pass: true, checks };
  }
  const mutants = generateMutants(candidate.source, maxMutants);
  if (mutants === null) {
    // Not "nothing to break" — the gate could not read the candidate under any
    // dialect it knows, so the mutation evidence is absent rather than empty.
    checks.push({ check: 'mutation', pass: false, verified: true, detail: 'candidate does not parse' });
    return { pass: false, checks };
  }
  if (mutants.length === 0) {
    checks.push({ check: 'mutation', pass: true, verified: true, detail: 'no mutation points' });
    return { pass: true, checks };
  }
  let killed = 0;
  for (const m of mutants) {
    const r = await checkReplay(m.source, evidence, invoker);
    if (!r.pass) { killed++; continue; }
    const s = await checkSchema(m.source, evidence, invoker);
    if (!s.pass) { killed++; continue; }
    const rel = await checkRelations(m.source, evidence, invoker);
    if (!rel.pass) killed++;
  }
  const killRatio = killed / mutants.length;
  const pass = killRatio >= killThreshold;
  checks.push({ check: 'mutation', pass, verified: true,
    detail: `${killed}/${mutants.length} mutants killed (threshold ${killThreshold})` });
  return { pass, checks, killRatio };
}

/** The one line the loop's driver reads. A verdict whose checks judged no
 *  evidence must not read like one that judged plenty, so checks that verified
 *  nothing are named rather than silently counted among the passes. */
export function summarizeVerdict(verdict: Verdict): string {
  if (!verdict.pass) {
    const failed = verdict.checks.filter(c => !c.pass).map(c => `${c.check}: ${c.detail}`).join('; ');
    return `fitness: FAIL — ${failed}`;
  }
  const kill = verdict.killRatio !== undefined ? `, kill ${verdict.killRatio.toFixed(2)}` : '';
  const names = verdict.checks.map(c => c.check).join(', ');
  const unverified = verdict.checks.filter(c => !c.verified).map(c => c.check);
  const caveat = unverified.length > 0 ? ` — unverified: ${unverified.join(', ')}` : '';
  return `fitness: PASS (${names}${kill})${caveat}`;
}

/** What a verdict is ABOUT: the target it was earned against, the source, and
 *  the declarations it was judged under. A redrafted manifest invalidates a
 *  verdict exactly as a redrafted source does, and a verdict earned with no
 *  target (a spawn) says nothing about any existing object. Components are
 *  hashed separately before the outer hash: `source` is generated text that
 *  may contain any byte, so field boundaries must not be reconstructible from
 *  a delimited concatenation. */
export function verdictDigest(source: string, methods: MethodDeclaration[], targetId?: string): string {
  return sha256(sha256(targetId ?? '') + sha256(source) + sha256(canonicalJson(methods)));
}

/** The hard gate deploy ops consult. A deploy may proceed only when the
 *  CURRENT draft has a passing verdict -- verdicts do not survive edits --
 *  and only onto the target inside that verdict's digest: deploy_update can
 *  resolve an explicit target the gate never saw, and a targetless (spawn)
 *  verdict earns nothing against any existing object. The target lives in
 *  the digest preimage rather than beside it, so there is no state to check
 *  separately and no unbound case to slip through. */
export function deployGate(state: { fitnessVerdict?: Verdict; fitnessSourceDigest?: string },
                           draftSource: string,
                           methods: MethodDeclaration[],
                           resolvedTargetId?: string): { ok: true } | { ok: false; error: string } {
  if (!state.fitnessVerdict || state.fitnessSourceDigest !== verdictDigest(draftSource, methods, resolvedTargetId)) {
    return { ok: false, error: 'deploy refused: no passing fitness verdict for this draft and target — run fitness' };
  }
  if (!state.fitnessVerdict.pass) {
    const failed = state.fitnessVerdict.checks.find(c => !c.pass);
    return { ok: false, error: `deploy refused: fitness failed (${failed?.check}: ${failed?.detail})` };
  }
  return { ok: true };
}
