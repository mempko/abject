/**
 * Proxy routes: how a negotiated connection reaches its proxy, on every bus.
 *
 * When the Negotiator connects two objects whose interfaces differ, it spawns
 * a proxy that translates between them and installs a route: requests and
 * events from the source to the target go to the proxy instead, and so do
 * requests and events from the target back to the source. Neither object
 * knows; each keeps addressing the other by id.
 *
 * A route has to hold wherever the traffic flows. Objects live on the main
 * thread and in pool workers, and two objects in one worker (or in two
 * workers with a direct port) never touch the main bus. So the main bus owns
 * the table and copies every change to each pool worker (`proxy:route`,
 * `proxy:unroute`), and every bus applies the same table when it sends.
 *
 * Replies and errors pass untouched: each answers one request and must reach
 * the object that sent it. The proxy's own answers to the source are how the
 * connection's health is measured: each reply counts as a success and each
 * error as a failure, reported to HealthMonitor (`recordSuccess`,
 * `recordError`), which renegotiates a connection whose error rate passes its
 * threshold.
 */

import type { AbjectError, AbjectId, AbjectMessage } from '../core/types.js';
import { event } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';

export interface ProxyRoute {
  agreementId: string;
  sourceId: AbjectId;
  targetId: AbjectId;
  proxyId: AbjectId;
  /** Where the proxy's successes and failures are reported. */
  healthMonitorId?: AbjectId;
}

/** A routed message, and the health report to send beside it, if any. */
export interface RouteOutcome {
  message: AbjectMessage;
  report?: AbjectMessage;
}

export class ProxyRouteTable {
  private routes = new Map<string, ProxyRoute>();
  /** `${from}->${to}` for the pairs a route redirects. */
  private redirects = new Map<string, ProxyRoute>();
  /** `${proxyId}->${sourceId}`: the proxy's answers, which measure health. */
  private answers = new Map<string, ProxyRoute>();

  get size(): number {
    return this.routes.size;
  }

  all(): ProxyRoute[] {
    return [...this.routes.values()];
  }

  /** Install or replace the route for an agreement. */
  set(route: ProxyRoute): void {
    contractRequire(!!route.agreementId && !!route.sourceId && !!route.targetId && !!route.proxyId,
      'a proxy route names its agreement, source, target and proxy');
    contractRequire(route.proxyId !== route.sourceId && route.proxyId !== route.targetId,
      'a proxy is neither end of its own connection');
    this.remove(route.agreementId);
    this.routes.set(route.agreementId, route);
    this.redirects.set(`${route.sourceId}->${route.targetId}`, route);
    this.redirects.set(`${route.targetId}->${route.sourceId}`, route);
    this.answers.set(`${route.proxyId}->${route.sourceId}`, route);
    this.checkInvariants();
  }

  remove(agreementId: string): void {
    const route = this.routes.get(agreementId);
    if (!route) return;
    this.routes.delete(agreementId);
    for (const key of [`${route.sourceId}->${route.targetId}`, `${route.targetId}->${route.sourceId}`]) {
      if (this.redirects.get(key) === route) this.redirects.delete(key);
    }
    const answerKey = `${route.proxyId}->${route.sourceId}`;
    if (this.answers.get(answerKey) === route) this.answers.delete(answerKey);
    this.checkInvariants();
  }

  /**
   * The message as it should travel. Synchronous and cheap: every send on
   * every bus asks, and an empty table answers at once.
   */
  apply(message: AbjectMessage): RouteOutcome {
    if (this.routes.size === 0) return { message };
    const pair = `${message.routing.from}->${message.routing.to}`;
    const type = message.header.type;

    if (type === 'request' || type === 'event') {
      const route = this.redirects.get(pair);
      if (route) {
        return { message: { ...message, routing: { ...message.routing, to: route.proxyId } } };
      }
      return { message };
    }

    const route = this.answers.get(pair);
    if (!route?.healthMonitorId) return { message };
    const report = type === 'error'
      ? event(route.proxyId, route.healthMonitorId, 'recordError',
          { agreementId: route.agreementId, error: message.payload as AbjectError })
      : event(route.proxyId, route.healthMonitorId, 'recordSuccess', { agreementId: route.agreementId });
    return { message, report };
  }

  private checkInvariants(): void {
    invariant(this.answers.size <= this.routes.size, 'every answer key belongs to a route');
    invariant(this.redirects.size <= this.routes.size * 2, 'a route redirects at most two pairs');
  }
}
