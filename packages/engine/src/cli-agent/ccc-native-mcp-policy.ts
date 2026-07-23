import type { ResolvedMcpServerDefinition } from "@fusion/core";
import { isCccFusionProfile } from "./ccc-subscription-policy.js";

const CCC_NATIVE_MCP_ALLOWED_KEYS = new Set([
  "name",
  "transport",
  "url",
  "enabled",
]);

export type CccNativeMcpServerDefinition = ResolvedMcpServerDefinition & {
  transport: "streamable-http";
  url: string;
  enabled: true;
};

export class CccNativeMcpPolicyViolationError extends Error {
  readonly code = "CCC_NATIVE_MCP_POLICY_VIOLATION";

  constructor(public readonly serverIndex: number, reason: string) {
    super(`ccc-fusion native MCP server ${serverIndex} rejected: ${reason}`);
    this.name = "CccNativeMcpPolicyViolationError";
  }
}

function reject(index: number, reason: string): never {
  throw new CccNativeMcpPolicyViolationError(index, reason);
}

function validateLoopbackUrl(raw: unknown, index: number): string {
  if (typeof raw !== "string") {
    return reject(index, "URL must be a string");
  }
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/[^/?#][^?#]*)$/.exec(raw);
  if (!match) {
    return reject(
      index,
      "URL must use literal http://127.0.0.1 with an explicit positive port and path",
    );
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port > 65_535) {
    return reject(index, "port must be between 1 and 65535");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return reject(index, "URL is invalid");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return reject(index, "URL is outside the ccc-fusion loopback boundary");
  }
  return raw;
}

/**
 * Validate and normalize the only native MCP definition admitted by the
 * ccc-fusion CLI profile. Disabled entries are inert; ordinary profiles retain
 * their pre-Wave behavior and receive no native MCP settings.
 *
 * FNXC:CCCNativeMcp 2026-07-23-16:10:
 * Resolved MCP definitions can contain materialized secrets. The ccc CLI seam
 * therefore admits only a credential-free literal IPv4 loopback URL and rejects
 * every other field before adapter argv construction or process/session effects.
 */
export function resolveCccNativeMcpServers(
  settings: Record<string, unknown> | undefined | null,
): CccNativeMcpServerDefinition[] {
  if (!isCccFusionProfile(settings)) return [];
  const raw = settings?.mcpServers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return reject(-1, "mcpServers must be an array");
  }

  const validated: CccNativeMcpServerDefinition[] = [];
  const names = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index];
    if (
      candidate
      && typeof candidate === "object"
      && (candidate as { enabled?: unknown }).enabled === false
    ) {
      continue;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return reject(index, "definition must be an object");
    }
    const server = candidate as Record<string, unknown>;
    if (server.enabled !== undefined && server.enabled !== true) {
      return reject(index, "enabled must be true, false, or omitted");
    }
    for (const key of Object.keys(server)) {
      if (!CCC_NATIVE_MCP_ALLOWED_KEYS.has(key)) {
        return reject(index, "definition contains a forbidden configuration field");
      }
    }
    if (typeof server.name !== "string" || server.name.trim().length === 0) {
      return reject(index, "name must be a non-empty string");
    }
    if (names.has(server.name)) {
      return reject(index, "server names must be unique");
    }
    if (server.transport !== "streamable-http") {
      return reject(index, "transport must be streamable-http");
    }
    const url = validateLoopbackUrl(server.url, index);
    names.add(server.name);
    validated.push({
      name: server.name,
      transport: "streamable-http",
      url,
      enabled: true,
    });
  }
  return validated;
}

/**
 * Remove native MCP material from non-ccc and disabled-only settings, while
 * replacing admitted ccc definitions with the exact validated set.
 */
export function applyCccNativeMcpPolicy(
  settings: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  const { mcpServers: _ignored, ...withoutMcp } = settings ?? {};
  const servers = resolveCccNativeMcpServers(settings);
  return servers.length > 0
    ? { ...withoutMcp, mcpServers: servers }
    : withoutMcp;
}
