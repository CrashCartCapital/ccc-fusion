import type { CliAutonomyPosture, ResolvedMcpServerDefinition } from "@fusion/core";
import { validateCccLoopbackHttpUrl } from "../ccc-loopback-policy.js";
import {
  CCC_FUSION_POSTURE_PROFILE_KEY,
  CCC_FUSION_PROFILE,
  isCccFusionProfile,
} from "./ccc-subscription-policy.js";

const CCC_NATIVE_MCP_ALLOWED_KEYS = new Set([
  "name",
  "transport",
  "url",
  "enabled",
]);

export const CCC_FUSION_POSTURE_MCP_KEY = "cccFusionMcpServers";

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
  const validation = validateCccLoopbackHttpUrl(raw);
  return validation.ok ? validation.url : reject(index, validation.reason);
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

/**
 * Persist only the already-validated, credential-free ccc MCP set. An explicit
 * empty array distinguishes a Wave 2 session with no enabled servers from a
 * stale/malformed posture that lacks recovery material.
 */
export function persistCccNativeMcpPosture(
  posture: CliAutonomyPosture | null,
  settings: Record<string, unknown> | undefined | null,
): CliAutonomyPosture | null {
  if (!isCccFusionProfile(settings)) return posture;
  const servers = resolveCccNativeMcpServers(settings);
  return {
    ...(posture ?? {}),
    [CCC_FUSION_POSTURE_MCP_KEY]: servers.map((server) => ({ ...server })),
  };
}

function hasExactPersistedShape(
  candidate: unknown,
  expected: CccNativeMcpServerDefinition,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const record = candidate as Record<string, unknown>;
  return Object.keys(record).length === 4
    && record.name === expected.name
    && record.transport === expected.transport
    && record.url === expected.url
    && record.enabled === true;
}

/**
 * Restore only sanitized ccc MCP material from the durable posture. Caller
 * settings are never used as a recovery source, so restart cannot re-resolve
 * secret-bearing definitions or smuggle arbitrary settings into adapter argv.
 */
export function restoreCccNativeMcpSettings(
  settings: Record<string, unknown> | undefined | null,
  posture: CliAutonomyPosture | null,
): Record<string, unknown> {
  const restored = { ...(settings ?? {}) };
  if (posture?.[CCC_FUSION_POSTURE_PROFILE_KEY] !== CCC_FUSION_PROFILE) {
    return restored;
  }
  if (!Object.prototype.hasOwnProperty.call(posture, CCC_FUSION_POSTURE_MCP_KEY)) {
    return reject(-1, "persisted configuration is missing");
  }
  const raw = posture[CCC_FUSION_POSTURE_MCP_KEY];
  if (!Array.isArray(raw)) {
    return reject(-1, "persisted configuration must be an array");
  }
  const servers = resolveCccNativeMcpServers({
    profile: CCC_FUSION_PROFILE,
    mcpServers: raw,
  });
  if (
    raw.length !== servers.length
    || raw.some((candidate, index) => !hasExactPersistedShape(candidate, servers[index]!))
  ) {
    return reject(-1, "persisted configuration is not the exact sanitized shape");
  }
  return {
    ...restored,
    mcpServers: servers,
  };
}
