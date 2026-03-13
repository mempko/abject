/**
 * Log — unified logging with process-relative timestamps.
 *
 * Every log line shows time since process start (T+), making it easy to
 * correlate events across the whole system.
 *
 * Basic usage (replaces console.log/warn):
 *   const log = new Log('MY-TAG');
 *   log.info('connected');         // [MY-TAG T+450ms] connected
 *   log.warn('timeout', err);      // [MY-TAG T+820ms] timeout Error: ...
 *
 * Sequential timing (for profiling multi-step operations):
 *   const log = new Log('BOOT');
 *   log.timed('step 1');           // [BOOT +0ms Δ0ms] step 1
 *   await slow();
 *   log.timed('step 2');           // [BOOT +120ms Δ120ms] step 2
 *   log.summary();                 // [BOOT] total: 120ms
 */

/** Process-level epoch for T+ timestamps. */
const T0 = Date.now();

export class Log {
  private readonly tag: string;

  // For timed() sequential profiling
  private timedStart = 0;
  private timedLast = 0;

  constructor(tag: string) {
    this.tag = tag;
  }

  /** One-off info log: [TAG T+Nms] message */
  info(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      console.log(`[${this.tag} T+${Date.now() - T0}ms] ${message}`, ...args);
    } else {
      console.log(`[${this.tag} T+${Date.now() - T0}ms] ${message}`);
    }
  }

  /** One-off warning: [TAG T+Nms] message */
  warn(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      console.warn(`[${this.tag} T+${Date.now() - T0}ms] ${message}`, ...args);
    } else {
      console.warn(`[${this.tag} T+${Date.now() - T0}ms] ${message}`);
    }
  }

  /** One-off error: [TAG T+Nms] message */
  error(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      console.error(`[${this.tag} T+${Date.now() - T0}ms] ${message}`, ...args);
    } else {
      console.error(`[${this.tag} T+${Date.now() - T0}ms] ${message}`);
    }
  }

  /**
   * Sequential timing step: [TAG +elapsed Δdelta] message
   * Auto-starts timing on first call.
   */
  timed(message: string): void {
    const now = Date.now();
    if (!this.timedStart) {
      this.timedStart = now;
      this.timedLast = now;
    }
    const elapsed = now - this.timedStart;
    const delta = now - this.timedLast;
    this.timedLast = now;
    console.log(`[${this.tag} +${elapsed}ms Δ${delta}ms] ${message}`);
  }

  /** Summary line: [TAG] total: Nms {message} */
  summary(message?: string): void {
    const elapsed = Date.now() - this.timedStart;
    const suffix = message ? ` ${message}` : '';
    console.log(`[${this.tag}] total: ${elapsed}ms${suffix}`);
  }
}

/** @deprecated Use Log instead */
export const TimedLog = Log;
