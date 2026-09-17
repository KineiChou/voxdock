import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConsoleAccountStore } from './console-account.js';

const normalize = (address: string) => address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address.toLowerCase();
export function isLocalConsoleClient(peer: string | undefined, forwarded: string | string[] | undefined, trustedProxyAddresses: readonly string[] = []): boolean {
  if (!peer || !isIP(peer)) return false;
  let client = normalize(peer);
  if (trustedProxyAddresses.some(address => isIP(address) && normalize(address) === client)) {
    // Trusted reverse proxies must replace X-Forwarded-For with exactly one original address.
    if (typeof forwarded !== 'string' || !isIP(forwarded)) return false;
    client = normalize(forwarded);
  } else if (forwarded !== undefined) return false;
  if (isIP(client) === 4) {
    const [a, b] = client.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return client === '::1' || /^f[cd][0-9a-f]{2}:/.test(client);
}
export function isConsoleManagementPath(url: string): boolean {
  let path: string;
  try { path = decodeURIComponent(url.split('?')[0]!); } catch { return true; }
  return /^\/(?:admin\/v1|v1\/console)\/(?:account|settings|connections)(?:\/|$)/.test(path) || /^\/console\/(?:settings|connections)(?:\/|$)/.test(path);
}
export function requestAllowsManagement(request: FastifyRequest, trustedProxyAddresses: readonly string[] = []): boolean {
  return isLocalConsoleClient(request.raw.socket.remoteAddress, request.headers['x-forwarded-for'], trustedProxyAddresses);
}
export function enforceConsoleManagementAccess(request: FastifyRequest, reply: FastifyReply, account: ConsoleAccountStore, trustedProxyAddresses: readonly string[] = []) {
  if (!account.read().allow_remote_management && isConsoleManagementPath(request.url) && !requestAllowsManagement(request, trustedProxyAddresses)) {
    return reply.code(403).send({ error: 'remote_management_disabled' });
  }
}
