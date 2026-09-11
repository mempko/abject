import test from 'node:test';
import assert from 'node:assert/strict';
import { stepUrgency, stepProgress } from './agent-abject.js';

const progressing = { progressHistory: Array.from({ length: 8 }, (_, i) => ({ novel: i % 2 === 0 || i < 4 })) };
const spinning = { actionHistory: ['read:a:ok', 'read:a:ok', 'read:a:ok', 'read:a:err', 'read:a:err', 'read:a:err'] };

test('a progressing task near the budget hears about the extension instead of "last step"', () => {
  const task = { step: 48, maxSteps: 50, ...progressing };
  assert.equal(stepProgress(task).progressing, true);
  const note = stepUrgency(task, true);
  assert.match(note, /Budget check in 2 steps/);
  assert.match(note, /up to 70 steps in all/);
  assert.match(note, /Do not compress or skip verification/);
  assert.doesNotMatch(note, /LAST STEP/);
});

test('a task with no extension left, or no progress, still hears the hard limit', () => {
  assert.match(stepUrgency({ step: 68, maxSteps: 70, extensionsGranted: 2, ...progressing }, true), /LAST STEP/);
  assert.match(stepUrgency({ step: 46, maxSteps: 50, ...spinning }, stepProgress({ step: 46, maxSteps: 50, ...spinning }).progressing), /no extension is available/);
  assert.equal(stepUrgency({ step: 10, maxSteps: 50, ...progressing }, true), '', 'nothing to say far from the budget');
});

test('one extension used leaves one to announce', () => {
  const note = stepUrgency({ step: 57, maxSteps: 60, extensionsGranted: 1, ...progressing }, true);
  assert.match(note, /Budget check in 3 steps/);
  assert.match(note, /up to 70 steps in all/);
});
