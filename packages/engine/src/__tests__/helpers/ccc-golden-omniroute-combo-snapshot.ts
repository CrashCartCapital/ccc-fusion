import { createHash } from "node:crypto";

export type GoldenTerminalRouteMember = Readonly<{
  provider: string;
  model: string;
}>;

export type GoldenOmniRouteComboSnapshot = Readonly<{
  alias: string;
  comboId: string;
  version: number;
  updatedAt: string;
  terminalRouteMembers: readonly GoldenTerminalRouteMember[];
  sourceDigest: string;
  digest: string;
}>;

type ComboRecord = Readonly<{
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  strategy: unknown;
  config: unknown;
  models: readonly unknown[];
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function comboRecord(value: unknown, index: number): ComboRecord {
  const combo = record(value, `OmniRoute combo ${index}`);
  if (!Number.isSafeInteger(combo.version) || (combo.version as number) < 1) {
    throw new Error(`OmniRoute combo ${index} version must be a positive integer`);
  }
  if (!Array.isArray(combo.models) || combo.models.length === 0) {
    throw new Error(`OmniRoute combo ${index} models must be a non-empty array`);
  }
  return {
    id: text(combo.id, `OmniRoute combo ${index} id`),
    name: text(combo.name, `OmniRoute combo ${index} name`),
    version: combo.version as number,
    updatedAt: text(combo.updatedAt, `OmniRoute combo ${index} updatedAt`),
    strategy: combo.strategy,
    config: combo.config,
    models: combo.models,
  };
}

function terminalMember(modelId: unknown, label: string): GoldenTerminalRouteMember {
  const providerQualified = text(modelId, label);
  const separator = providerQualified.indexOf("/");
  if (
    separator <= 0
    || separator === providerQualified.length - 1
    || providerQualified.indexOf("/", separator + 1) !== -1
  ) {
    throw new Error(`${label} must use exact provider/model form`);
  }
  return {
    provider: providerQualified.slice(0, separator),
    model: providerQualified.slice(separator + 1),
  };
}

function assertNoLuna(value: unknown): void {
  if (/luna|gpt-5\.6-luna/iu.test(JSON.stringify(value))) {
    throw new Error("Luna is forbidden in the selected OmniRoute combo closure");
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function snapshotDigest(
  snapshot: Omit<GoldenOmniRouteComboSnapshot, "digest">,
): string {
  return sha256(snapshot);
}

export function sealGoldenOmniRouteComboSnapshot(
  value: unknown,
  alias: string,
): GoldenOmniRouteComboSnapshot {
  const payload = record(value, "OmniRoute combo response");
  if (!Array.isArray(payload.combos)) {
    throw new Error("OmniRoute combo response combos must be an array");
  }
  const combos = payload.combos.map(comboRecord);
  const byName = new Map<string, ComboRecord>();
  for (const combo of combos) {
    if (byName.has(combo.name)) throw new Error(`duplicate OmniRoute combo name ${combo.name}`);
    byName.set(combo.name, combo);
  }
  const selected = byName.get(alias);
  if (!selected) throw new Error(`OmniRoute combo ${alias} not found`);

  const terminalRouteMembers: GoldenTerminalRouteMember[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const closure: unknown[] = [];
  const visit = (comboName: string): void => {
    const combo = byName.get(comboName);
    if (!combo) throw new Error(`OmniRoute combo ${comboName} not found`);
    if (active.has(comboName)) throw new Error(`OmniRoute combo cycle includes ${comboName}`);
    if (visited.has(comboName)) return;
    active.add(comboName);
    closure.push({
      id: combo.id,
      name: combo.name,
      version: combo.version,
      updatedAt: combo.updatedAt,
      strategy: combo.strategy,
      config: combo.config,
      models: combo.models,
    });
    for (const [index, rawStep] of combo.models.entries()) {
      const step = record(rawStep, `OmniRoute combo ${comboName} model ${index}`);
      const kind = text(step.kind, `OmniRoute combo ${comboName} model ${index} kind`);
      if (kind === "combo-ref") {
        visit(text(step.comboName, `OmniRoute combo ${comboName} model ${index} comboName`));
        continue;
      }
      if (kind !== "model") {
        throw new Error(`OmniRoute combo ${comboName} model ${index} has unsupported kind ${kind}`);
      }
      terminalRouteMembers.push(terminalMember(
        step.model,
        `OmniRoute combo ${comboName} model ${index} model`,
      ));
    }
    active.delete(comboName);
    visited.add(comboName);
  };
  visit(alias);
  assertNoLuna(closure);
  if (terminalRouteMembers.length === 0) {
    throw new Error(`OmniRoute combo ${alias} has no terminal members`);
  }
  const unique = new Set<string>();
  const deduplicatedTerminalRouteMembers = terminalRouteMembers.filter((member) => {
    const key = `${member.provider}/${member.model}`;
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });
  const sealedWithoutDigest = {
    alias,
    comboId: selected.id,
    version: selected.version,
    updatedAt: selected.updatedAt,
    terminalRouteMembers: deduplicatedTerminalRouteMembers,
    sourceDigest: sha256({ alias, closure }),
  };
  return { ...sealedWithoutDigest, digest: snapshotDigest(sealedWithoutDigest) };
}

export function parseGoldenOmniRouteComboSnapshot(
  serialized: string,
  expectedAlias: string,
): GoldenOmniRouteComboSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("golden OmniRoute combo snapshot must be valid JSON");
  }
  const snapshot = record(parsed, "golden OmniRoute combo snapshot");
  const expectedKeys = [
    "alias",
    "comboId",
    "digest",
    "sourceDigest",
    "terminalRouteMembers",
    "updatedAt",
    "version",
  ];
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("golden OmniRoute combo snapshot fields are not exact");
  }
  const alias = text(snapshot.alias, "golden OmniRoute combo snapshot alias");
  if (alias !== expectedAlias) {
    throw new Error(`golden OmniRoute combo snapshot alias ${alias} does not match ${expectedAlias}`);
  }
  if (!Number.isSafeInteger(snapshot.version) || (snapshot.version as number) < 1) {
    throw new Error("golden OmniRoute combo snapshot version must be a positive integer");
  }
  if (typeof snapshot.digest !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.digest)) {
    throw new Error("golden OmniRoute combo snapshot digest must be sha256");
  }
  if (typeof snapshot.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.sourceDigest)) {
    throw new Error("golden OmniRoute combo snapshot sourceDigest must be sha256");
  }
  if (!Array.isArray(snapshot.terminalRouteMembers) || snapshot.terminalRouteMembers.length === 0) {
    throw new Error("golden OmniRoute combo snapshot terminalRouteMembers must be non-empty");
  }
  const terminalRouteMembers = snapshot.terminalRouteMembers.map((value, index) => {
    const member = record(value, `golden OmniRoute combo snapshot member ${index}`);
    if (JSON.stringify(Object.keys(member).sort()) !== JSON.stringify(["model", "provider"])) {
      throw new Error(`golden OmniRoute combo snapshot member ${index} fields are not exact`);
    }
    return {
      provider: text(member.provider, `golden OmniRoute combo snapshot member ${index} provider`),
      model: text(member.model, `golden OmniRoute combo snapshot member ${index} model`),
    };
  });
  assertNoLuna(terminalRouteMembers);
  const unique = new Set(terminalRouteMembers.map(({ provider, model }) => `${provider}/${model}`));
  if (unique.size !== terminalRouteMembers.length) {
    throw new Error("golden OmniRoute combo snapshot has duplicate terminal member");
  }
  const parsedSnapshotWithoutDigest = {
    alias,
    comboId: text(snapshot.comboId, "golden OmniRoute combo snapshot comboId"),
    version: snapshot.version as number,
    updatedAt: text(snapshot.updatedAt, "golden OmniRoute combo snapshot updatedAt"),
    terminalRouteMembers,
    sourceDigest: snapshot.sourceDigest,
  };
  if (snapshotDigest(parsedSnapshotWithoutDigest) !== snapshot.digest) {
    throw new Error("golden OmniRoute combo snapshot digest does not match its contents");
  }
  return { ...parsedSnapshotWithoutDigest, digest: snapshot.digest };
}

export async function fetchGoldenOmniRouteComboSnapshot(input: Readonly<{
  baseUrl: string;
  managementApiKey: string;
  alias: string;
}>): Promise<GoldenOmniRouteComboSnapshot> {
  if (!input.managementApiKey) {
    throw new Error("OMNIROUTE_MCP_MANAGEMENT_API_KEY is required for sealed combo preflight");
  }
  const response = await fetch(new URL("/api/combos", input.baseUrl), {
    headers: { Authorization: `Bearer ${input.managementApiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OmniRoute combo preflight failed with HTTP ${response.status}`);
  }
  return sealGoldenOmniRouteComboSnapshot(await response.json(), input.alias);
}
