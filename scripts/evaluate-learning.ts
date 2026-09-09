/** Score model review outputs against a labeled corpus. This does not simulate model judgment. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type Case = { id: string; expected: { verdict: string; dispositions: string[]; scope?: string; patternVerdict?: string } };
type Answer = { id: string; verdict: string; disposition: string; scope?: string; patternVerdict?: string; llmCalls?: number; tokens?: number };
export function evaluate(cases: Case[], answers: Answer[]) {
  const rows = cases.map(c => {
    const matching = answers.filter(a => a.id === c.id), a = matching[0];
    const errors: string[] = [];
    if (matching.length !== 1) errors.push('Expected exactly one answer');
    if (a?.verdict !== c.expected.verdict) errors.push('Assessment disagrees with evidence');
    if (!c.expected.dispositions.includes(a?.disposition)) errors.push('Unsupported knowledge disposition');
    if (c.expected.scope && a?.disposition !== 'no_change' && a?.scope !== c.expected.scope) errors.push('Correction loses applicability scope');
    if (c.expected.patternVerdict && a?.patternVerdict !== c.expected.patternVerdict) errors.push('Usefulness is not established by mere use or success');
    return { id:c.id, passed:errors.length===0, errors };
  });
  return { cases:cases.length, correct:rows.filter(r=>r.passed).length, missing:cases.filter(c=>!answers.some(a=>a.id===c.id)).length,
    unexpectedAnswers:answers.filter(a=>!cases.some(c=>c.id===a.id)).map(a=>a.id),
    unsupportedChanges:rows.filter(r=>r.errors.some(e=>/Unsupported|scope/.test(e))).length,
    llmCalls:answers.reduce((n,a)=>n+(a.llmCalls??0),0), tokens:answers.reduce((n,a)=>n+(a.tokens??0),0), rows };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/evaluate-learning.ts <review-answers.json>');
  const cases = JSON.parse(await readFile(new URL('../tests/fixtures/learning-judgment.json',import.meta.url),'utf8'));
  const answers = JSON.parse(await readFile(process.argv[2],'utf8'));
  const result = evaluate(cases,answers);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.correct!==result.cases||result.unexpectedAnswers.length) process.exitCode=1;
}
