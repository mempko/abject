/**
 * Where outbound connections may go: the private-address (SSRF) guard shared
 * by HttpClient and StreamClient.
 *
 * The guard checks the addresses a host resolves to, not the name as written,
 * so a public name pointing at 127.0.0.1 is refused as surely as the literal.
 * Private and internal addresses are refused unless the instance owner listed
 * the host under Private hosts in Settings > Permissions. Public addresses
 * always pass here; the domain allow and deny lists are checked separately.
 *
 * A Private hosts entry is one of:
 *   - a name, optionally with a port:   localhost:11434, models.internal
 *   - a wildcard name:                  *.corp.example (subdomains, not the apex)
 *   - an address, optionally with port: 127.0.0.1:8080, [::1]:8080, ::1
 *   - an address range (every port):    10.0.0.0/8, fd00::/8
 * A name entry lets that name reach whatever it resolves to. An address or
 * range entry lets any name reach the addresses it covers. Every private
 * address a host resolves to must be covered before the host is allowed, so
 * listing 127.0.0.1 does not open a name that also resolves to ::1.
 */

import * as dns from 'dns';
import * as net from 'net';
import { domainToASCII } from 'url';

/** Loopback, private, link-local (cloud metadata), shared (CGNAT), and
 *  reserved ranges. Node matches IPv4 rules against IPv4-mapped IPv6
 *  addresses (::ffff:a.b.c.d) as well. */
const PRIVATE_RANGES = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  PRIVATE_RANGES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 96],          // unspecified, loopback, IPv4-compatible
  ['64:ff9b:1::', 48], // local-use NAT64
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
  ['fec0::', 10],      // site-local (deprecated)
  ['ff00::', 8],       // multicast
] as const) {
  PRIVATE_RANGES.addSubnet(address, prefix, 'ipv6');
}

/** Well-known NAT64 prefix: the address stands for the IPv4 one in its low
 *  32 bits, which is what gets checked. */
const NAT64 = new net.BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

/** A request refused by policy rather than failed by the network. Callers
 *  that retry on failure do not retry these. */
export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

/** Resolves a host name to every address it has. Injectable for tests. */
export type HostLookup = (hostname: string) => Promise<dns.LookupAddress[]>;

const systemLookup: HostLookup = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/** True for loopback, private, link-local, and reserved addresses. Anything
 *  that does not parse as an address counts as private (fail closed). */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, ''); // IPv6 zone id
  const family = net.isIP(bare);
  if (family === 4) return PRIVATE_RANGES.check(bare, 'ipv4');
  if (family !== 6) return true;
  if (PRIVATE_RANGES.check(bare, 'ipv6')) return true;
  if (NAT64.check(bare, 'ipv6')) return isPrivateAddress(lowIPv4(bare));
  return false;
}

/** The IPv4 address in the low 32 bits of an IPv6 address. */
function lowIPv4(address: string): string {
  const dotted = address.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const groups = address.split(':');
  const hi = parseInt(groups[groups.length - 2] || '0', 16);
  const lo = parseInt(groups[groups.length - 1] || '0', 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** The port a URL connects to, filling in the scheme's default. */
export function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

/** Lowercase, without IPv6 brackets or a trailing dot. */
function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  return bare.endsWith('.') ? bare.slice(0, -1) : bare;
}

type PrivateHostRule =
  | { kind: 'name'; name: string; wildcard: boolean; port?: number }
  | { kind: 'address'; addresses: net.BlockList; port?: number };

/** Parse one Private hosts entry, or undefined when it is not one. */
export function parsePrivateHost(raw: string): PrivateHostRule | undefined {
  const entry = raw.trim().toLowerCase();
  if (!entry) return undefined;

  const slash = entry.indexOf('/');
  if (slash >= 0) {
    const address = normalizeHost(entry.slice(0, slash));
    const prefixText = entry.slice(slash + 1);
    const prefix = Number(prefixText);
    const family = net.isIP(address);
    const max = family === 4 ? 32 : 128;
    if (!family || !/^\d+$/.test(prefixText) || prefix > max) return undefined;
    const addresses = new net.BlockList();
    addresses.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
    return { kind: 'address', addresses };
  }

  let host: string;
  let portText: string | undefined;
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  const named = entry.match(/^([^:[\]]+)(?::(\d+))?$/);
  if (bracketed) [, host, portText] = bracketed;
  else if (net.isIPv6(entry)) host = entry;
  else if (named) [, host, portText] = named;
  else return undefined;

  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;

  host = normalizeHost(host);
  const family = net.isIP(host);
  if (family) {
    const addresses = new net.BlockList();
    addresses.addAddress(host, family === 4 ? 'ipv4' : 'ipv6');
    return { kind: 'address', addresses, port };
  }

  const wildcard = host.startsWith('*.');
  const name = domainToASCII(wildcard ? host.slice(2) : host);
  if (!name || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name)) return undefined;
  return { kind: 'name', name, wildcard, port };
}

/**
 * The private-address guard for one set of Private hosts entries. Entries
 * that do not parse are ignored; `entries` keeps the ones in force.
 */
export class AddressPolicy {
  readonly entries: readonly string[];
  private readonly rules: PrivateHostRule[] = [];

  constructor(entries: readonly string[] = [], private readonly lookup: HostLookup = systemLookup) {
    const kept: string[] = [];
    for (const entry of entries) {
      const rule = parsePrivateHost(entry);
      if (!rule) continue;
      this.rules.push(rule);
      kept.push(entry.trim().toLowerCase());
    }
    this.entries = kept;
  }

  /**
   * Refuse a destination whose host resolves to a private address that no
   * entry allows. Throws NetworkPolicyError when refused; a failed lookup
   * rejects with the resolver's error, as the connection itself would.
   *
   * This resolves the host separately from the connection that follows, so a
   * name whose DNS answer changes in between (DNS rebinding) can still slip
   * through. Use connectLookup where the socket API accepts one; it checks
   * the addresses the socket actually uses.
   */
  async check(hostname: string, port: number): Promise<void> {
    const host = normalizeHost(hostname);
    if (this.allowsName(host, port)) return;
    this.verify(host, port, await this.addressesOf(host));
  }

  /**
   * A `lookup` for net/tls/http(s) connections and ws: it resolves the name
   * and applies the same check to the addresses the socket will connect to.
   * Sockets to an address literal skip lookup; check() covers those.
   */
  connectLookup(port: number): net.LookupFunction {
    return (hostname, options, callback) => {
      const host = normalizeHost(hostname);
      const fail = (err: NodeJS.ErrnoException) => callback(err, '', 0);
      this.addressesOf(host).then((resolved) => {
        try {
          if (!this.allowsName(host, port)) this.verify(host, port, resolved);
        } catch (err) {
          fail(err as NodeJS.ErrnoException);
          return;
        }
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const usable = family === 4 || family === 6 ? resolved.filter(a => a.family === family) : resolved;
        if (usable.length === 0) {
          const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          err.code = 'ENOTFOUND';
          fail(err);
        } else if (options.all) {
          callback(null, usable);
        } else {
          callback(null, usable[0].address, usable[0].family);
        }
      }, fail);
    };
  }

  private async addressesOf(host: string): Promise<dns.LookupAddress[]> {
    const family = net.isIP(host);
    return family ? [{ address: host, family }] : this.lookup(host);
  }

  private allowsName(host: string, port: number): boolean {
    return this.rules.some(rule => rule.kind === 'name'
      && (rule.port === undefined || rule.port === port)
      && (rule.wildcard ? host.endsWith(`.${rule.name}`) : host === rule.name));
  }

  private allowsAddress(address: string, port: number): boolean {
    const bare = address.replace(/%.*$/, '');
    const family = net.isIP(bare) === 4 ? 'ipv4' : 'ipv6';
    return this.rules.some(rule => rule.kind === 'address'
      && (rule.port === undefined || rule.port === port)
      && rule.addresses.check(bare, family));
  }

  private verify(host: string, port: number, resolved: dns.LookupAddress[]): void {
    for (const { address } of resolved) {
      if (!isPrivateAddress(address) || this.allowsAddress(address, port)) continue;
      const literal = net.isIP(host) !== 0;
      const what = literal ? `Address ${host} is` : `Domain ${host} resolves to ${address}, which is`;
      const entry = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
      throw new NetworkPolicyError(
        `${what} a private or internal address and is blocked. ` +
        `To allow it, add "${entry}" to Private hosts in Settings > Permissions.`,
      );
    }
  }
}
