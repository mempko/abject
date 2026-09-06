import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentAbject, type AgentAction } from './agent-abject.js';

interface AgentAbjectHarness {
  parseAction(entry: unknown, content: string, streamTruncated?: boolean): AgentAction;
  isTerminalAction(entry: unknown, action: AgentAction): 'success' | 'error' | null;
}

function makeEntry(): any {
  return {
    state: {
      id: 'terminal-normalization-test',
      phase: 'thinking',
      step: 0,
      maxSteps: 25,
      task: 'Write the declared scratchpad output and finish',
      llmMessages: [],
      timeout: 1_000,
    },
    agentId: 'test-agent',
    callerId: 'test-caller',
    systemPrompt: '',
    dispatchTupleId: 'task-with-declared-produces',
    config: {
      maxSteps: 25,
      maxConcurrentTasks: 1,
      timeout: 1_000,
      pinnedMessageCount: 2,
      maxConversationMessages: 20,
      directExecution: false,
      skipFirstObservation: false,
      terminalActions: {
        done: { type: 'success', resultFields: ['result'] },
        fail: { type: 'error', resultFields: ['reason', 'error'] },
      },
      intermediateActions: [],
      fallbackActionName: 'done',
    },
  };
}

function harness(): AgentAbjectHarness {
  return new AgentAbject() as unknown as AgentAbjectHarness;
}

test('accepts canonical done.result unchanged', () => {
  const runtime = harness();
  const entry = makeEntry();

  const action = runtime.parseAction(entry, '{"action":"done","result":"complete"}');

  assert.deepEqual(action, { action: 'done', result: 'complete' });
  assert.equal(entry.parseFailures, 0);
});

test('normalizes unambiguous terminal aliases into result before validation', () => {
  for (const alias of ['text', 'content', 'message'] as const) {
    const runtime = harness();
    const entry = makeEntry();
    const action = runtime.parseAction(entry, JSON.stringify({ action: 'done', [alias]: `${alias} value` }));

    assert.equal(action.action, 'done');
    assert.equal(action.result, `${alias} value`);
    assert.equal(entry.parseFailures, 0);
  }
});

test('rejects a genuinely empty done terminal and requests the exact required shape', () => {
  const runtime = harness();
  const entry = makeEntry();

  const action = runtime.parseAction(entry, JSON.stringify({
    action: 'done',
    result: ' ',
    text: '',
    content: '  ',
    message: null,
  }));

  assert.equal(action.action, '_reparse');
  assert.equal(entry.parseFailures, 1);
  assert.match(entry.state.llmMessages.at(-1)?.content ?? '', /\{"action":"done","result":"\.\.\."\}/);
});

test('alias terminal completes cleanly after declared scratchpad output without a retry', () => {
  const runtime = harness();
  const entry = makeEntry();
  entry.state.lastResult = {
    success: true,
    data: { key: 'declared-output', written: true },
  };

  const action = runtime.parseAction(entry, '{"action":"done","content":"Wrote declared-output"}');
  const terminal = runtime.isTerminalAction(entry, action);

  assert.equal(action.action, 'done');
  assert.equal(action.result, 'Wrote declared-output');
  assert.equal(terminal, 'success');
  assert.equal(entry.state.result, 'Wrote declared-output');
  assert.equal(entry.parseFailures, 0);
  assert.equal(entry.state.llmMessages.length, 0);
});

test('passes agent-defined actions through parse so the agent act handler can judge them', () => {
  // Agents (Chat's `goal`, ScrumMaster's `dispatch_scrum`, an ObjectAgent's
  // dependency calls) define their vocabulary in `act`, not in the config
  // manifest, so parse must not reject verbs it does not know.
  for (const actionName of ['goal', 'dispatch_scrum', 'invented_action']) {
    const runtime = harness();
    const entry = makeEntry();

    const action = runtime.parseAction(entry, JSON.stringify({ action: actionName, description: 'x' }));

    assert.equal(action.action, actionName);
    assert.equal(entry.parseFailures, 0);
  }
});

test('accepts configured intermediate and runtime actions from the action manifest', () => {
  const runtime = harness();
  const entry = makeEntry();
  entry.config.intermediateActions.push('read');

  assert.equal(runtime.parseAction(entry, '{"action":"read","path":"x"}').action, 'read');
  assert.equal(runtime.parseAction(entry, '{"action":"submit_job","code":"return 1"}').action, 'submit_job');
  assert.equal(entry.parseFailures, 0);
});
