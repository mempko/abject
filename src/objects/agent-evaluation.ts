import { withKeyedLock } from '../core/keyed-lock.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { describeMessages, protocolText, protocolObject } from '../core/protocol-description.js';
import { AGENT_EVALUATION_CASES, type EvaluationCondition } from '../evaluation/agent-cases.js';

interface EvaluationOutcome {
  caseId: string; condition: EvaluationCondition; repetition: number; family: string;
  accepted: boolean; claimedSuccess: boolean; elapsedMs: number; error?: string;
  tokens?: number; costUsd?: number; interventions?: number; askCalls?: number;
  duplicateEffects?: number; recovered?: boolean; evidence?: unknown;
  llmCalls?: number; inspectionReads?: number; repeatedInspectionReads?: number; proposalAgreement?: boolean;
  fixture?: unknown; decisionTrace?: unknown; patternRevisions?: unknown;
}
interface EvaluationRun { id: string; status: 'running' | 'complete' | 'cancelled' | 'interrupted'; seed: number; outcomes: EvaluationOutcome[]; startedAt: number; endedAt?: number; agreement?: unknown; fingerprints?: Record<string, string>; }
const conditions: EvaluationCondition[] = ['fresh','frozen','learning'];

/** Owns evaluation criteria and records; execution and independent verification are message collaborators. */
export class AgentEvaluation extends Abject {
  private runs = new Map<string, EvaluationRun>();
  private admitting = false;
  private storageId?: AbjectId;
  constructor() {
    super({ manifest: { name: 'AgentEvaluation', version: '1.0.0', description: 'Repeatable agent reliability, continuation, and longitudinal learning evaluation. Ask for the driver and independent verifier protocols.',
      interface: { id: 'abjects:agent-evaluation', name: 'AgentEvaluation', description: 'Evidence-backed agent evaluation', methods: [] }, requiredCapabilities: [], providedCapabilities: [], tags: ['system','agent','evaluation'] } });
    describeMessages(this.manifest, [
      { name:'listCases', description:'Read the acceptance catalog, including continuation and proposal reuse scenarios.', parameters:{} },
      { name:'run', description:'Start a comparison using driverId, verifierId, optional caseIds, conditions (fresh/frozen/learning), repetitions and seed. Driver and verifier must be distinct Abjects. Returns a run id.', parameters:{ driverId:protocolText, verifierId:protocolText, options:protocolObject } },
      { name:'list', description:'List durable evaluation reports, including interrupted runs. Interrupted effects are never replayed automatically.', parameters:{} },
      { name:'get', description:'Inspect outcomes, evidence, latency, cost and uncertainty for a run.', parameters:{ id:protocolText } },
      { name:'cancel', description:'Cancel remaining episodes; current episode still cleans up its isolated fixture.', parameters:{ id:protocolText } },
    ]);
    this.on('listCases', () => structuredClone(AGENT_EVALUATION_CASES));
    this.on('list', async () => {
      if (!this.storageId) return [];
      const index = await this.request<string[] | null>(request(this.id, this.storageId, 'get', { key: 'evaluation:index' }));
      const runs = await Promise.all((index ?? []).map(id => this.loadRun(id)));
      return runs.filter((r): r is EvaluationRun => !!r).map(({ outcomes, ...r }) => ({ ...r, report: this.report(outcomes) }));
    });
    this.on('get', async msg => {
      const run = await this.loadRun((msg.payload as {id:string}).id);
      return run ? { ...structuredClone(run), report:this.report(run.outcomes) } : null;
    });
    this.on('cancel', async msg => {
      const run = this.runs.get((msg.payload as {id:string}).id);
      if (!run) return false;
      run.status = 'cancelled'; await this.persist(run); return true;
    });
    this.on('run', async msg => {
      const p = msg.payload as { driverId:AbjectId; verifierId:AbjectId; options?: { caseIds?:string[]; conditions?:EvaluationCondition[]; repetitions?:number; seed?:number } };
      if (!p.driverId || !p.verifierId || p.driverId === p.verifierId) throw new Error('A driver and a distinct independent verifier are required');
      if (this.admitting || [...this.runs.values()].some(r=>r.status==='running')) throw new Error('An evaluation is already running');
      const opts = p.options ?? {}, selected = [...(opts.caseIds ?? AGENT_EVALUATION_CASES.map(c=>c.id))];
      if (!selected.length || selected.some(id=>!AGENT_EVALUATION_CASES.some(c=>c.id===id))) throw new Error('Unknown or empty case selection');
      const modes = [...(opts.conditions ?? conditions)];
      if (new Set(selected).size !== selected.length || new Set(modes).size !== modes.length) throw new Error('Duplicate cases or conditions would bias the comparison');
      if (opts.seed !== undefined && !Number.isSafeInteger(opts.seed)) throw new Error('Seed must be a safe integer');
      if (!modes.length || modes.some(c=>!conditions.includes(c))) throw new Error('Unknown memory condition');
      const repetitions = opts.repetitions ?? 1;
      if (!Number.isInteger(repetitions) || repetitions<1 || repetitions>100) throw new Error('Repetitions must be between 1 and 100');
      this.admitting = true;
      try {
      // Ask exposes constraints and semantics; the explicit receipt seals the operational agreement.
      const agreement = await this.request(request(this.id,p.driverId,'ask',{ question:'Explain your evaluation protocol: prepareEvaluation, executeEvaluation, cleanupEvaluation. Each trial needs isolated project/workspace and memory snapshots, a configurationFingerprint for model/capability/budget, baselineMemoryFingerprint, isolated:true and condition in each fixture receipt; fresh/frozen/learning memory conditions and evidence-addressable outputs. Criteria and hidden fixtures must stay outside evaluated agent memory. Explain unsupported cases. When instrumented, report llmCalls and inspectionReads from execution traces, including proposal and follow-up phase details in decisionTrace. Do not invent missing metrics.' }));
      const protocol = await this.request<{version:number; supportsConditions:EvaluationCondition[]}>(request(this.id,p.driverId,'evaluationProtocol',{}));
      if (protocol.version!==1 || modes.some(c=>!protocol.supportsConditions.includes(c))) throw new Error('Driver cannot honor requested comparison conditions');
      await this.request(request(this.id,p.verifierId,'ask',{ question:'Explain verifyEvaluation: independently inspect fixture effects against evaluator-supplied acceptance criteria; return accepted, evidence, duplicateEffects and recovered. Do not trust the agent completion claim. For continuation cases, report proposalAgreement only when actual effects were compared with the accepted proposal, and repeatedInspectionReads for redundant reads of unchanged previously reviewed inputs. Freshness checks, necessary missing-evidence reads, and validation of the executed artifact are not redundant inspection. Omit unavailable metrics.' }));
      const run:EvaluationRun = { id:`evaluation-${crypto.randomUUID()}`, status:'running', seed:opts.seed ?? 1, outcomes:[], startedAt:Date.now(), agreement };
      await this.persist(run); this.runs.set(run.id,run);
      void this.execute(run,p.driverId,p.verifierId,selected,modes,repetitions).catch(async err=>{
        run.status='cancelled'; run.endedAt=Date.now(); this.changed('evaluationError',{id:run.id,error:String(err)}); await this.persist(run);
      });
      return {id:run.id};
      } finally { this.admitting = false; }
    });
  }
  private async execute(run:EvaluationRun,driver:AbjectId,verifier:AbjectId,ids:string[],modes:EvaluationCondition[],repetitions:number):Promise<void> {
    for (let repetition=0; repetition<repetitions; repetition++) for (const condition of modes) {
      // Stable order within each trial. Related episodes share only that trial's memory clone.
      const trialId=`${run.id}:${repetition}:${condition}`;
      for (const caseId of ids) {
        if (run.status!=='running') return;
        const c=AGENT_EVALUATION_CASES.find(c=>c.id===caseId)!;
        const started=Date.now(); let fixture:unknown;
        const outcome:EvaluationOutcome={caseId,condition,repetition,family:c.family,accepted:false,claimedSuccess:false,elapsedMs:0};
        try {
          fixture=await this.request(request(this.id,driver,'prepareEvaluation',{trialId,caseId,condition,seed:run.seed+repetition}),120000);
          outcome.fixture=fixture;
          const receipt = fixture as { configurationFingerprint?: string; baselineMemoryFingerprint?: string; condition?: string; isolated?: boolean };
          if (!receipt?.configurationFingerprint || !receipt.baselineMemoryFingerprint || receipt.condition !== condition || receipt.isolated !== true) throw new Error('Fixture must attest configurationFingerprint, baselineMemoryFingerprint, condition and isolated:true');
          const fingerprint = JSON.stringify([receipt.configurationFingerprint, receipt.baselineMemoryFingerprint]);
          const key = `${repetition}:${caseId}`;
          run.fingerprints ??= {};
          if (run.fingerprints[key] && run.fingerprints[key] !== fingerprint) throw new Error('Comparison configuration or initial memory changed between conditions');
          run.fingerprints[key] = fingerprint;
          const result=await this.request<any>(request(this.id,driver,'executeEvaluation',{trialId,caseId,intent:c.intent,fixture}),1800000);
          outcome.claimedSuccess=result.success===true;
          for (const key of ['tokens','costUsd','interventions','askCalls','decisionTrace','patternRevisions'] as const) if (result[key]!==undefined) (outcome as any)[key]=result[key];
          for (const key of ['llmCalls','inspectionReads'] as const) if (Number.isSafeInteger(result[key]) && result[key] >= 0) outcome[key]=result[key];
          const verdict=await this.request<any>(request(this.id,verifier,'verifyEvaluation',{trialId,caseId,fixture,acceptance:c.acceptance,artifactRefs:result.artifactRefs}),120000);
          outcome.accepted=verdict.accepted===true && verdict.evidence!==undefined;
          outcome.evidence=verdict.evidence; outcome.duplicateEffects=verdict.duplicateEffects; outcome.recovered=verdict.recovered;
          if (verdict.evidence !== undefined) {
            if (typeof verdict.proposalAgreement === 'boolean') outcome.proposalAgreement=verdict.proposalAgreement;
            if (Number.isSafeInteger(verdict.repeatedInspectionReads) && verdict.repeatedInspectionReads >= 0) outcome.repeatedInspectionReads=verdict.repeatedInspectionReads;
          }
        } catch (err) { outcome.error=String(err); }
        finally {
          try { await this.request(request(this.id,driver,'cleanupEvaluation',{trialId,caseId,fixture,condition}),120000); }
          catch (err) { outcome.accepted=false; outcome.error=`${outcome.error ?? ''} Cleanup failed: ${String(err)}`; }
          outcome.elapsedMs=Date.now()-started; run.outcomes.push(outcome); await this.persist(run);
          this.changed('evaluationEpisode',{id:run.id,outcome});
        }
      }
    }
    if (run.status === 'running') run.status='complete'; run.endedAt=Date.now(); await this.persist(run);
    this.changed('evaluationCompleted',{id:run.id,report:this.report(run.outcomes)});
  }
  private report(outcomes:EvaluationOutcome[]):unknown {
    return Object.fromEntries(conditions.map(condition=>{
      const rows=outcomes.filter(o=>o.condition===condition), n=rows.length, accepted=rows.filter(o=>o.accepted).length;
      const latency=rows.map(o=>o.elapsedMs).sort((a,b)=>a-b), z=1.96, p=n?accepted/n:0;
      const center=n?(p+z*z/(2*n))/(1+z*z/n):0, margin=n?z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+z*z/n):0;
      return [condition,{episodes:n,accepted,acceptanceRate:n?p:null,acceptance95Wilson:n?[center-margin,center+margin]:null,
        falseSuccess:rows.filter(o=>o.claimedSuccess&&!o.accepted).length, failures:rows.filter(o=>o.error).length,
        p50Ms:n?latency[Math.floor((n-1)*.5)]:null,p95Ms:n?latency[Math.ceil((n-1)*.95)]:null,
        costUsd:rows.reduce((sum,o)=>sum+(o.costUsd??0),0),unpricedEpisodes:rows.filter(o=>o.costUsd===undefined).length,
        tokens:rows.reduce((sum,o)=>sum+(o.tokens??0),0), unreportedTokenEpisodes:rows.filter(o=>o.tokens===undefined).length,
        costPerAccepted:accepted && rows.every(o=>o.costUsd!==undefined) ? rows.reduce((sum,o)=>sum+o.costUsd!,0)/accepted : null,
        tokensPerAccepted:accepted && rows.every(o=>o.tokens!==undefined) ? rows.reduce((sum,o)=>sum+o.tokens!,0)/accepted : null,
        interventions:rows.reduce((sum,o)=>sum+(o.interventions??0),0), unreportedInterventionEpisodes:rows.filter(o=>o.interventions===undefined).length,
        askCalls:rows.reduce((sum,o)=>sum+(o.askCalls??0),0), recovered:rows.filter(o=>o.recovered===true).length,
        recoveryRate:rows.some(o=>o.recovered!==undefined) ? rows.filter(o=>o.recovered===true).length/rows.filter(o=>o.recovered!==undefined).length : null,
        failuresByFamily:Object.fromEntries([...new Set(rows.map(o=>o.family))].map(family=>[family,rows.filter(o=>o.family===family&&!o.accepted).length])),
        duplicateEffects:rows.reduce((sum,o)=>sum+(o.duplicateEffects??0),0),
        ...Object.fromEntries((['llmCalls','inspectionReads','repeatedInspectionReads'] as const).map(key=>[key,{
          total:rows.some(o=>o[key]!==undefined) ? rows.reduce((sum,o)=>sum+(o[key]??0),0) : null,
          reportedEpisodes:rows.filter(o=>o[key]!==undefined).length, unreportedEpisodes:rows.filter(o=>o[key]===undefined).length,
        }])),
        proposalAgreement:{matched:rows.filter(o=>o.proposalAgreement===true).length,mismatched:rows.filter(o=>o.proposalAgreement===false).length,unassessed:rows.filter(o=>o.proposalAgreement===undefined).length},
        note:'Repeated episodes may be correlated; inspect paired per-case outcomes and trial fingerprints before making comparative claims.'}];
    }));
  }
  private async persist(run:EvaluationRun):Promise<void> {
    if (!this.storageId) throw new Error('Storage unavailable for evaluation evidence');
    await withKeyedLock(`${this.id}:evaluation-storage`, async () => {
      const index = await this.request<string[] | null>(request(this.id, this.storageId!, 'get', { key: 'evaluation:index' }));
      if (!(index ?? []).includes(run.id)) await this.request(request(this.id, this.storageId!, 'set', { key: 'evaluation:index', value: [...(index ?? []), run.id] }));
      await this.request(request(this.id,this.storageId!,'set',{key:`evaluation:${run.id}`,value:structuredClone(run)}));
    });
  }
  private async loadRun(id: string): Promise<EvaluationRun | null> {
    const live = this.runs.get(id);
    if (live) return live;
    if (!this.storageId) return null;
    const stored = await this.request<EvaluationRun | null>(request(this.id, this.storageId, 'get', { key: `evaluation:${id}` }));
    if (!stored) return null;
    if (stored.status === 'running') { stored.status = 'interrupted'; stored.endedAt = Date.now(); await this.persist(stored); }
    this.runs.set(id, stored);
    return stored;
  }
  protected override async onInit():Promise<void> { this.storageId=await this.discoverDep('Storage')??undefined; }
}
