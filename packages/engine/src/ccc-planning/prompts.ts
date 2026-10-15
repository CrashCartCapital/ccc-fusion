/**
 * FNXC:CccPlanningPrompts 2026-10-14-18:53: card RP, PRD v3 section 4, D47.
 * The versioned, digested table of FULL-v2 role prompts, and the only way a prompt string is produced.
 *
 * - `buildCccPlanningPromptTable` validates a list of role prompt sources and derives each role's digest. It refuses a list that
 *   does not cover every role of the policy exactly once, and any template whose placeholders are not exactly its declared packet
 *   inputs (each used once), so a prompt can never interpolate anything the controller did not declare.
 * - A role digest is sha256 over a domain tag, a NUL byte and the canonical JSON of the role id, version, and every variant's
 *   name, declared inputs and template. It is what binds into `CccPlanningRouteBinding.promptDigest` and the artifact policy
 *   (`promptDigest`); one changed byte in any of those changes it.
 * - `renderCccPlanningPrompt` fills the placeholders of one variant in a single pass from a packet that has exactly the declared
 *   keys. It reads no clock, environment or random source, and a packet value is inserted literally: a value that looks like a
 *   placeholder or a replacement pattern is not expanded.
 * - `computeCccPlanningPromptSetDigest` is the qualification certificate's `prompts` digest (ADR D): sha256 over the sorted
 *   (role, promptVersion, promptSha256) triples.
 * A bad source or packet is a controller bug, so it refuses `CCC_PLANNING_INTERNAL_ERROR`, never a new code.
 */
import { createHash } from "node:crypto";
import {
  CCC_PLANNING_ROLE_POLICY_FULL_V2,
  CccPlanningRefusal,
  canonicalCccPrdJson,
  deepFreezeCccPlanningConstant,
  type CccPlanningRoleId,
} from "@fusion/core";
import {
  CCC_PLANNING_ROLE_PROMPT_SOURCES,
  type CccPlanningPromptVariantSource,
  type CccPlanningRolePromptSource,
} from "./roles.js";

export const CCC_PLANNING_PROMPT_SET_ID = "ccc-planning.prompt-set.v1" as const;

const DIGEST_DOMAIN = "ccc-planning-prompt/v1";
const SET_DIGEST_DOMAIN = "ccc-planning-prompt-set/v1";
const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9]*$/u;
const VARIANT_NAME = /^[a-z][a-z0-9-]*$/u;
const POLICY_ROLE_IDS: ReadonlySet<string> = new Set(CCC_PLANNING_ROLE_POLICY_FULL_V2.roles.map((spec) => spec.roleId));

export type CccPlanningRolePrompt = Readonly<{
  roleId: CccPlanningRoleId;
  promptVersion: string;
  variants: readonly CccPlanningPromptVariantSource[];
  digest: string;
}>;
export type CccPlanningPromptTable = Readonly<{ promptSetId: typeof CCC_PLANNING_PROMPT_SET_ID; prompts: readonly CccPlanningRolePrompt[] }>;
/** Text inputs are one string; list inputs are an array of single-line strings. Nothing else is accepted. */
export type CccPlanningPromptPacket = Readonly<Record<string, string | readonly string[]>>;
export type CccPlanningRenderedPrompt = Readonly<{
  roleId: CccPlanningRoleId;
  variant: string;
  promptVersion: string;
  promptDigest: string;
  prompt: string;
}>;

function refuse(detail: string, field?: string): never {
  throw new CccPlanningRefusal("CCC_PLANNING_INTERNAL_ERROR", detail, field);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function checkVariant(roleId: string, variant: CccPlanningPromptVariantSource): void {
  const where = `prompt ${roleId}/${String(variant.name)}`;
  if (typeof variant.name !== "string" || !VARIANT_NAME.test(variant.name)) refuse(`${where}: variant name must match ${String(VARIANT_NAME)}`);
  if (typeof variant.template !== "string" || variant.template.length === 0) refuse(`${where}: template must be a non-empty string`);
  const declared = new Set<string>();
  for (const input of variant.inputs) {
    if (typeof input.name !== "string" || !INPUT_NAME.test(input.name)) refuse(`${where}: input name ${JSON.stringify(input.name)} must be letters and digits`, String(input.name));
    if (declared.has(input.name)) refuse(`${where}: input ${input.name} is declared twice`, input.name);
    if (input.kind !== "text" && input.kind !== "list") refuse(`${where}: input ${input.name} kind must be text or list`, input.name);
    if (typeof input.about !== "string" || input.about.length === 0) refuse(`${where}: input ${input.name} needs a description`, input.name);
    declared.add(input.name);
  }
  const used = new Map<string, number>();
  for (const match of variant.template.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!declared.has(name)) refuse(`${where}: placeholder {{${name}}} is not a declared packet input`, name);
    used.set(name, (used.get(name) ?? 0) + 1);
  }
  for (const name of declared) {
    const count = used.get(name) ?? 0;
    if (count !== 1) refuse(`${where}: declared input ${name} must appear exactly once in the template, found ${count}`, name);
  }
  if (/\{\{|\}\}/u.test(variant.template.replace(PLACEHOLDER, ""))) refuse(`${where}: template has a stray double brace`);
  if (variant.template.includes("${")) refuse(`${where}: template has an unresolved JavaScript placeholder`);
}

function checkSource(source: CccPlanningRolePromptSource, seen: Set<string>): void {
  if (!POLICY_ROLE_IDS.has(source.roleId)) refuse(`prompt for unknown role ${JSON.stringify(source.roleId)}`);
  if (seen.has(source.roleId)) refuse(`role ${source.roleId} has more than one prompt`);
  seen.add(source.roleId);
  const version = new RegExp(`^ccc-planning\\.prompt\\.${source.roleId}\\.v[1-9][0-9]*$`, "u");
  if (typeof source.promptVersion !== "string" || !version.test(source.promptVersion)) {
    refuse(`prompt ${source.roleId}: version ${JSON.stringify(source.promptVersion)} must be ccc-planning.prompt.${source.roleId}.v<n> with n from 1`);
  }
  if (!Array.isArray(source.variants) || source.variants.length === 0) refuse(`prompt ${source.roleId}: needs at least one variant`);
  const names = new Set<string>();
  for (const variant of source.variants) {
    if (names.has(variant.name)) refuse(`prompt ${source.roleId}: variant ${variant.name} appears twice`);
    names.add(variant.name);
    checkVariant(source.roleId, variant);
  }
}

function digestOf(source: CccPlanningRolePromptSource): string {
  return sha256(`${DIGEST_DOMAIN}\0${canonicalCccPrdJson({
    roleId: source.roleId,
    promptVersion: source.promptVersion,
    variants: source.variants.map((variant) => ({
      name: variant.name,
      inputs: variant.inputs.map((input) => ({ name: input.name, kind: input.kind, about: input.about })),
      template: variant.template,
    })),
  })}`);
}

export function buildCccPlanningPromptTable(sources: readonly CccPlanningRolePromptSource[] = CCC_PLANNING_ROLE_PROMPT_SOURCES): CccPlanningPromptTable {
  const seen = new Set<string>();
  for (const source of sources) checkSource(source, seen);
  for (const roleId of POLICY_ROLE_IDS) if (!seen.has(roleId)) refuse(`role ${roleId} has no prompt`);
  // Fresh copies, so freezing the table never freezes a caller's objects.
  const prompts = sources.map((source): CccPlanningRolePrompt => ({
    roleId: source.roleId,
    promptVersion: source.promptVersion,
    variants: source.variants.map((variant) => ({
      name: variant.name,
      inputs: variant.inputs.map((input) => ({ name: input.name, kind: input.kind, about: input.about })),
      template: variant.template,
    })),
    digest: digestOf(source),
  }));
  return deepFreezeCccPlanningConstant({ promptSetId: CCC_PLANNING_PROMPT_SET_ID, prompts });
}

export const CCC_PLANNING_PROMPT_TABLE: CccPlanningPromptTable = buildCccPlanningPromptTable();

function promptForRole(roleId: CccPlanningRoleId): CccPlanningRolePrompt {
  const found = CCC_PLANNING_PROMPT_TABLE.prompts.find((prompt) => prompt.roleId === roleId);
  if (!found) refuse(`no prompt for role ${JSON.stringify(roleId)}`);
  return found;
}

/** The version and digest to bind before a session exists (`promptVersion` and `promptDigest` of the artifact policy and the route binding). */
export function cccPlanningPromptIdentity(roleId: CccPlanningRoleId): Readonly<{ promptVersion: string; promptDigest: string }> {
  const prompt = promptForRole(roleId);
  return Object.freeze({ promptVersion: prompt.promptVersion, promptDigest: prompt.digest });
}

function checkLine(value: unknown, name: string, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n\0]/u.test(value)) {
    refuse(`packet input ${name}: ${what} must be a non-empty single line without NUL`, name);
  }
  return value;
}

function renderValue(input: CccPlanningPromptVariantSource["inputs"][number], value: unknown): string {
  if (input.kind === "text") {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
      refuse(`packet input ${input.name} must be a non-empty text without NUL`, input.name);
    }
    return value;
  }
  if (!Array.isArray(value)) refuse(`packet input ${input.name} must be a list of lines`, input.name);
  if (value.length === 0) return "- (none)";
  return value.map((item) => `- ${checkLine(item, input.name, "each list item")}`).join("\n");
}

/**
 * Renders one variant. `variant` may be left out only for a role with a single prompt. The packet must carry exactly the
 * variant's declared inputs: an undeclared key, a missing key or a malformed value refuses and renders nothing.
 */
export function renderCccPlanningPrompt(roleId: CccPlanningRoleId, packet: CccPlanningPromptPacket, variant?: string): CccPlanningRenderedPrompt {
  const prompt = promptForRole(roleId);
  let chosen: CccPlanningPromptVariantSource | undefined;
  if (variant === undefined) {
    if (prompt.variants.length !== 1) {
      refuse(`role ${roleId} has ${prompt.variants.length} prompts (${prompt.variants.map((entry) => entry.name).join(", ")}); name one`);
    }
    chosen = prompt.variants[0];
  } else {
    chosen = prompt.variants.find((entry) => entry.name === variant);
    if (!chosen) refuse(`role ${roleId} has no prompt variant ${JSON.stringify(variant)}`);
  }
  const selected = chosen as CccPlanningPromptVariantSource;
  const declared = new Set(selected.inputs.map((input) => input.name));
  for (const key of Object.keys(packet)) {
    if (!declared.has(key)) refuse(`packet input ${key} is not declared for ${roleId}/${selected.name}`, key);
  }
  const values = new Map<string, string>();
  for (const input of selected.inputs) {
    if (!Object.prototype.hasOwnProperty.call(packet, input.name)) refuse(`packet input ${input.name} is missing for ${roleId}/${selected.name}`, input.name);
    values.set(input.name, renderValue(input, packet[input.name]));
  }
  // One pass over the template; a function replacement, so a value is never re-scanned or read as a replacement pattern.
  const rendered = selected.template.replace(PLACEHOLDER, (_whole, name: string) => values.get(name) as string);
  return Object.freeze({ roleId, variant: selected.name, promptVersion: prompt.promptVersion, promptDigest: prompt.digest, prompt: rendered });
}

/** The `prompts` digest of a qualification certificate (ADR D): sha256 over the sorted (role, promptVersion, promptSha256) triples. */
export function computeCccPlanningPromptSetDigest(table: CccPlanningPromptTable = CCC_PLANNING_PROMPT_TABLE): string {
  const entries = table.prompts
    .map((prompt) => ({ role: prompt.roleId as string, promptVersion: prompt.promptVersion, promptSha256: prompt.digest }))
    .sort((left, right) => (left.role < right.role ? -1 : left.role > right.role ? 1 : 0));
  return sha256(`${SET_DIGEST_DOMAIN}\0${canonicalCccPrdJson(entries)}`);
}
