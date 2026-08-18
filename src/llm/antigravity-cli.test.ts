/**
 * Unit test for AntigravityCliProvider
 */
import { AntigravityCliProvider, extractAgyStreamDelta, extractAgyStreamResultText, extractAgyStreamError, extractAgyStreamUsage } from './antigravity-cli.js';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests() {
  console.log('Testing AntigravityCliProvider...');

  const provider = new AntigravityCliProvider();
  assert(provider.name === 'antigravity-cli', 'provider name should be antigravity-cli');

  const desc = provider.describe();
  assert(desc.id === 'antigravity-cli', 'desc.id should be antigravity-cli');
  assert(desc.label === 'Antigravity CLI', 'desc.label should be Antigravity CLI');
  assert(desc.credentialMode === 'cli', 'desc.credentialMode should be cli');
  assert(desc.cli?.binary === 'agy', 'desc.cli.binary should be agy');
  assert(desc.defaultTierModels?.smart === 'auto', 'desc.defaultTierModels.smart should be auto');
  assert(desc.models.some(m => m.id === 'gemini-3.7-flash-medium'), 'desc.models should include gemini-3.7-flash-medium');
  assert(desc.models.some(m => m.id === 'gemini-3.6-flash-medium'), 'desc.models should include gemini-3.6-flash-medium');
  assert(desc.models.some(m => m.id === 'gemini-3.1-pro-high'), 'desc.models should include gemini-3.1-pro-high');
  assert(!desc.models.some(m => m.id === 'gemini-3.6-pro'), 'desc.models must not include gemini-3.6-pro (not a real agy model)');
  const models = await provider.listModels();
  assert(models.length === desc.models.length, 'listModels() and describe().models should stay in sync');

  const available = await provider.isAvailable();
  console.log('AntigravityCliProvider isAvailable:', available);
  if (!available) {
    // Not an assertion: the agy binary is an environment precondition, not
    // provider behavior — parser tests below run everywhere regardless.
    console.warn('agy not on PATH — skipping availability check');
  }

  // Test stream delta extraction
  const stepUpdateLine = JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'Hello World'
    }
  });
  assert(extractAgyStreamDelta(stepUpdateLine) === 'Hello World', 'stream delta should extract text_delta');

  // Test result text extraction
  const resultLine = JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'Hello World Complete'
    }
  });
  assert(extractAgyStreamResultText(resultLine) === 'Hello World Complete', 'result text should extract response');

  // Test error extraction
  const errorLine = JSON.stringify({
    event: 'result',
    result: {
      status: 'ERROR',
      error: 'invalid model selection'
    }
  });
  assert(extractAgyStreamError(errorLine) === 'invalid model selection', 'error extraction should extract result.error');

  // Test usage extraction
  const usageLine = JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150
      }
    }
  });
  const usage = extractAgyStreamUsage(usageLine);
  assert(usage?.inputTokens === 100, 'inputTokens should be 100');
  assert(usage?.outputTokens === 50, 'outputTokens should be 50');

  console.log('All AntigravityCliProvider tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
