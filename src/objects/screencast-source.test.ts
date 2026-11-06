/**
 * The push-based capture source: frames arrive unprompted, the poll takes the
 * newest one, and nothing is left running when the page goes away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ScreencastSource, type ScreencastCdp, type ScreencastFrameEvent } from './screencast-source.js';

const FRAME_A = Buffer.from('frame-a-bytes').toString('base64');
const FRAME_B = Buffer.from('frame-b-longer').toString('base64');

class FakeCdp implements ScreencastCdp {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  detached = 0;
  private handlers: Array<(event: ScreencastFrameEvent) => void> = [];
  refuseStart = false;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === 'Page.startScreencast' && this.refuseStart) throw new Error('not supported');
    return {};
  }

  on(_event: 'Page.screencastFrame', handler: (event: ScreencastFrameEvent) => void): void {
    this.handlers.push(handler);
  }

  off(_event: 'Page.screencastFrame', handler: (event: ScreencastFrameEvent) => void): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  async detach(): Promise<void> {
    this.detached += 1;
  }

  push(data: string, sessionId: number, timestamp?: number): void {
    for (const handler of [...this.handlers]) {
      handler({ data, sessionId, ...(timestamp !== undefined ? { metadata: { timestamp } } : {}) });
    }
    // The ack is sent from a promise; let it settle.
    return;
  }

  get startCalls(): number {
    return this.sent.filter((s) => s.method === 'Page.startScreencast').length;
  }

  get ackCount(): number {
    return this.sent.filter((s) => s.method === 'Page.screencastFrameAck').length;
  }
}

async function started(options?: { format?: 'png' | 'jpeg' }): Promise<{ cdp: FakeCdp; source: ScreencastSource }> {
  const cdp = new FakeCdp();
  const source = new ScreencastSource(cdp, options);
  await source.start();
  return { cdp, source };
}

/** Let the ack promises queued by push() run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('start asks the renderer for PNG frames one at a time', async () => {
  const { cdp } = await started();
  const start = cdp.sent.find((s) => s.method === 'Page.startScreencast');
  assert.deepEqual(start?.params, { format: 'png', everyNthFrame: 1 });
});

test('the size and quality options are passed through to the renderer', async () => {
  const cdp = new FakeCdp();
  const source = new ScreencastSource(cdp, { format: 'jpeg', quality: 80, maxWidth: 960, maxHeight: 540 });
  await source.start();
  assert.deepEqual(cdp.sent[0]!.params, {
    format: 'jpeg', quality: 80, maxWidth: 960, maxHeight: 540, everyNthFrame: 1,
  });
});

test('only the newest frame is taken, and every pushed frame is acked', async () => {
  const { cdp, source } = await started();
  cdp.push(FRAME_A, 1);
  cdp.push(FRAME_B, 2);
  await settle();

  const frame = source.takeNewest();
  assert.equal(frame?.data.toString(), 'frame-b-longer');
  assert.equal(source.takeNewest(), undefined, 'the older frame was superseded, not queued');
  assert.equal(cdp.ackCount, 2, 'a dropped frame is acked too, or the renderer stalls');
  assert.deepEqual(source.stats, { pushed: 2, taken: 1, superseded: 1, pending: false });
});

test('a frame that arrives after a take is served on the next take', async () => {
  const { cdp, source } = await started();
  cdp.push(FRAME_A, 1);
  await settle();
  assert.equal(source.takeNewest()?.data.toString(), 'frame-a-bytes');

  cdp.push(FRAME_B, 2);
  await settle();
  assert.equal(source.takeNewest()?.data.toString(), 'frame-b-longer');
  assert.equal(await Promise.resolve(source.stats.pending), false);
});

test('the last taken frame stays available for a key frame re-encode', async () => {
  const { cdp, source } = await started();
  assert.equal(source.lastFrame(), undefined);
  cdp.push(FRAME_A, 1);
  await settle();
  const taken = source.takeNewest();
  assert.equal(source.lastFrame(), taken);
});

test('a page-reported capture time rides along with the frame', async () => {
  const { cdp, source } = await started();
  cdp.push(FRAME_A, 7, 1793936636.25);
  await settle();
  assert.equal(source.takeNewest()?.capturedAt, 1793936636.25);
});

test('stop turns the push off and detaches, and is safe twice', async () => {
  const { cdp, source } = await started();
  cdp.push(FRAME_A, 1);
  await settle();
  await source.stop();
  await source.stop();
  assert.equal(cdp.sent.filter((s) => s.method === 'Page.stopScreencast').length, 1);
  assert.equal(cdp.detached, 1);
  assert.equal(source.takeNewest(), undefined, 'a frame still waiting when the page goes is dropped');
});

test('a stopped source ignores frames still in flight', async () => {
  const { cdp, source } = await started();
  await source.stop();
  cdp.push(FRAME_A, 1);
  await settle();
  assert.equal(source.takeNewest(), undefined);
  assert.equal(source.stats.pushed, 0);
});

test('a host that refuses the screencast leaves no listener behind', async () => {
  const cdp = new FakeCdp();
  cdp.refuseStart = true;
  const source = new ScreencastSource(cdp);
  await assert.rejects(() => source.start(), /not supported/);
  cdp.push(FRAME_A, 1);
  await settle();
  assert.equal(cdp.ackCount, 0, 'no handler is listening after a refused start');
  await source.stop();
  assert.equal(cdp.detached, 0, 'stop does nothing when the push never started');
});

test('start cannot be called twice on one source', async () => {
  const { source } = await started();
  await assert.rejects(() => source.start(), /twice/);
});
