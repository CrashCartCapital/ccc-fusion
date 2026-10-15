import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CCC_PLANNING_COMPLETE_PHASE_TOOL,
  CCC_PLANNING_DENIED_NAMES,
  canonicalCccPrdJson,
  cccPlanningSessionToolNames,
  compareCccPrdCodeUnits,
  type CccPlanningRoleClass,
} from "@fusion/core";
import type { CccConfinement, CccExecutionToolAuthority, CccSessionToolPolicy } from "../agent-runtime.js";
import { createCccCampaignReadyTool } from "../ccc-campaign-ready.js";
import { isCccConfinedTool, markCccConfinedTool } from "./confined-fs-tools.js";
import { CCC_CONFINED_GREP_DEFAULT_LIMITS, createCccConfinedGrepTool } from "./confined-grep-tool.js";

/*
FNXC:CccSessionToolPolicy 2026-10-14-21:10:
Card C2 (D11, CONTRACT-v3 sections 2.12 and 2.13, verify-v2 item 37). A planning or planning-linked-writer session's tool set is closed: its final tools must equal the policy's allowed names, and their name and parameter-schema authorities must hash to the policy's toolset digest (sha256 of the canonical sorted CccExecutionToolAuthority list, the same per-tool schema hash pi.ts gives the receipt binder). Every tool under a confined name (bash, edit, find, grep, ls, read, write) must carry CCC_CONFINED_TOOL_MARK, so Pi's own grep, which runs rg, can never satisfy the grep name. A linked writer's fn_complete_phase must be the campaign ready tool in phase-signal mode, matched on name, label, description, execution mode and parameters. Every refusal is a CccSessionToolPolicyRefusedError that lists every problem.
*/
/*
FNXC:CccSessionToolPolicy 2026-10-14-22:58:
Card C2 repair 1. An issued policy is recognised by its content, not its object identity: buildCccSessionToolPolicy records sha256 of the canonical JSON of all six policy fields, so a caller that spreads, rebuilds or deserializes its issued policy in the same process is still recognised (verify-v2 item 37). Repair 2 (below) refuses every policy without a recorded key; the build's names-only check for such a policy is withdrawn. Under a tool policy the confined bash, write and edit are sequential tools, so Pi runs any message that contains one of them one call at a time: no shell command runs while a file operation is between its path check and its open.
*/

/*
FNXC:CccSessionToolPolicy 2026-10-15-00:32:
Card C2 repair 2 (errata E14 item C2-3; D11, verify-v2 item 37). The weaker names-only check for a hand-built policy, recorded as a deviation by the C2 build and by repair 1, is withdrawn and the check is fail-closed. createFnAgent refuses any policy whose content buildCccSessionToolPolicy did not issue in this process, first in resolveCccPolicySessionTools (before any MCP connection, tool or session) and again in the final check, and the final check runs the full assertCccSessionToolSet (names, digest, confinement marks and every non-confined policy tool, such as ccc_submit_verdict, ccc_submit_artifact, fn_complete_phase and ccc_probe_echo) for every policy. A policy rebuilt in another process, or after a restart, is refused rather than weakly checked. Obligation (E14): cards SF, WR and C6 build every session policy through buildCccSessionToolPolicy, in the process that creates the session.
*/

export class CccSessionToolPolicyRefusedError extends Error {
  readonly code = "CCC_SESSION_TOOL_POLICY_REFUSED" as const;
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`CCC_SESSION_TOOL_POLICY_REFUSED: ${problems.join("; ")}`);
    this.name = "CccSessionToolPolicyRefusedError";
    this.problems = Object.freeze([...problems]);
  }
}

/** Tool names a planning session may only fill with a Fusion confined tool. */
const CCC_CONFINED_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
/** sha256 content keys of every policy buildCccSessionToolPolicy issued in this process. */
const issuedPolicyKeys = new Set<string>();

/** Byte-for-byte the per-tool schema canonicalization pi.ts uses for the receipt binder's authorities. */
function canonicalToolSchemaJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CCC tool schema must be JSON-serializable");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalToolSchemaJson(entry, seen)).join(",")}]`;
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("CCC tool schema must not be circular");
    seen.add(value);
    const serialized = `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalToolSchemaJson(entry, seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  throw new Error("CCC tool schema must be JSON-serializable");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The content key of a policy: sha256 of the canonical JSON of its six fields, or null when they do not serialize. */
function policyContentKey(policy: CccSessionToolPolicy): string | null {
  try {
    return sha256(canonicalCccPrdJson({
      policyId: policy.policyId,
      allowedTools: [...policy.allowedTools],
      toolsetDigest: policy.toolsetDigest,
      readRoots: [...policy.readRoots],
      writeRoots: [...policy.writeRoots],
      deniedNames: [...policy.deniedNames],
    }));
  } catch {
    return null;
  }
}

/** The refusal for a policy whose content buildCccSessionToolPolicy never issued in this process, or null when it did. */
function notIssuedProblem(policy: CccSessionToolPolicy): string | null {
  const key = policyContentKey(policy);
  if (key !== null && issuedPolicyKeys.has(key)) return null;
  return `tool policy ${String(policy?.policyId)} was not built by buildCccSessionToolPolicy in this process`;
}

/** A sequential copy of a confined tool, so Pi never runs it beside another call of the same message. */
function sequential(tool: ToolDefinition): ToolDefinition {
  return { ...tool, executionMode: "sequential" };
}

/** The sorted name and parameter-schema authorities of a tool set. */
export function cccSessionToolAuthorities(tools: readonly ToolDefinition[]): CccExecutionToolAuthority[] {
  return tools
    .map((tool) => ({ authority: tool.name, parametersSha256: sha256(canonicalToolSchemaJson(tool.parameters)) }))
    .sort((left, right) => compareCccPrdCodeUnits(left.authority, right.authority)
      || compareCccPrdCodeUnits(left.parametersSha256, right.parametersSha256));
}

/** sha256(canonicalCccPrdJson(sorted CccExecutionToolAuthority[])), D11. */
export function cccSessionToolsetDigest(tools: readonly ToolDefinition[]): string {
  return sha256(canonicalCccPrdJson(cccSessionToolAuthorities(tools)));
}

/**
 * The Fusion confined tools for `names`: Pi's read, write, edit, ls, find and bash over the session confinement,
 * and the Fusion grep, each carrying CCC_CONFINED_TOOL_MARK.
 */
export function createCccConfinedSessionTools(i: Readonly<{ names: readonly string[]; confinement: CccConfinement; cwd: string;
  readRoots: readonly string[]; deniedNames: readonly string[] }>): ToolDefinition[] {
  const { fs, bash } = i.confinement;
  return i.names.map((name): ToolDefinition => {
    switch (name) {
      case "read": return markCccConfinedTool(createReadTool(i.cwd, { operations: fs.read }) as unknown as ToolDefinition);
      case "write": return markCccConfinedTool(sequential(createWriteTool(i.cwd, { operations: fs.write }) as unknown as ToolDefinition));
      case "edit": return markCccConfinedTool(sequential(createEditTool(i.cwd, { operations: fs.edit }) as unknown as ToolDefinition));
      case "ls": return markCccConfinedTool(createLsTool(i.cwd, { operations: fs.ls }) as unknown as ToolDefinition);
      case "find": return markCccConfinedTool(createFindTool(i.cwd, { operations: fs.find }) as unknown as ToolDefinition);
      case "grep":
        return createCccConfinedGrepTool({ fs, readRoots: i.readRoots, deniedNames: i.deniedNames, limits: CCC_CONFINED_GREP_DEFAULT_LIMITS });
      case "bash":
        if (!bash) throw new CccSessionToolPolicyRefusedError(["bash needs a confined shell (cccConfinement.bash)"]);
        return markCccConfinedTool(sequential(createBashTool(i.cwd, { operations: bash }) as unknown as ToolDefinition));
      default:
        throw new TypeError(`${name} is not a confined tool name`);
    }
  });
}

function readyToolProblems(tool: ToolDefinition): string[] {
  const reference = createCccCampaignReadyTool({ mode: "phase-signal", signalPhaseCompletion: () => undefined });
  const fields = ["name", "label", "description", "executionMode"] as const;
  const problems = fields
    .filter((field) => tool[field] !== reference[field])
    .map((field) => `${CCC_PLANNING_COMPLETE_PHASE_TOOL} ${field} is not the campaign ready tool's`);
  if (sha256(canonicalToolSchemaJson(tool.parameters)) !== sha256(canonicalToolSchemaJson(reference.parameters))) {
    problems.push(`${CCC_PLANNING_COMPLETE_PHASE_TOOL} parameters are not the campaign ready tool's`);
  }
  return problems;
}

/** Name-level problems of `tools` against exactly `allowed`: missing, extra and duplicate names, unmarked confined tools, a foreign ready tool. */
function toolSetProblems(allowed: readonly string[], tools: readonly ToolDefinition[]): string[] {
  const problems: string[] = [];
  const expected = new Set(allowed);
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = typeof tool?.name === "string" ? tool.name : String(tool?.name);
    if (seen.has(name)) problems.push(`${name} appears more than once`);
    seen.add(name);
    if (!expected.has(name)) {
      problems.push(`${name} is outside the policy`);
      continue;
    }
    if (CCC_CONFINED_TOOL_NAMES.has(name) && !isCccConfinedTool(tool)) {
      problems.push(`${name} is not a Fusion confined tool (no CCC_CONFINED_TOOL_MARK)`);
    }
    if (name === CCC_PLANNING_COMPLETE_PHASE_TOOL) problems.push(...readyToolProblems(tool));
  }
  for (const name of allowed) if (!seen.has(name)) problems.push(`${name} is missing`);
  return problems;
}

function canonicalRoots(roots: readonly string[], label: string): string[] {
  if (!Array.isArray(roots)) throw new TypeError(`${label} must be an array of absolute paths`);
  return roots.map((root) => {
    if (typeof root !== "string" || !isAbsolute(root)) throw new TypeError(`${label} must contain only absolute paths`);
    return realpathSync.native(root);
  });
}

export function buildCccSessionToolPolicy(i: Readonly<{ roleClass: CccPlanningRoleClass; probe?: boolean; linkedWriter?: boolean;
  readRoots: readonly string[]; writeRoots: readonly string[]; tools: readonly ToolDefinition[] }>): CccSessionToolPolicy {
  const linkedWriter = i.linkedWriter === true;
  const probe = i.probe === true;
  if (linkedWriter && i.roleClass !== "writer") {
    throw new TypeError(`a linked writer tool policy is only for role class writer, not ${String(i.roleClass)}`);
  }
  if (linkedWriter && probe) throw new TypeError("a linked writer tool policy is never a probe policy");
  const allowedTools = cccPlanningSessionToolNames({
    roleClass: i.roleClass,
    scopeKind: linkedWriter ? "planning-linked-writer" : "planning",
    probe,
  });
  const readRoots = canonicalRoots(i.readRoots, "readRoots");
  if (readRoots.length === 0) throw new TypeError("readRoots must name at least one root");
  const writeRoots = canonicalRoots(i.writeRoots, "writeRoots");
  if (i.roleClass !== "writer" && writeRoots.length > 0) {
    throw new TypeError(`writeRoots must be empty unless the role class is writer, not ${i.roleClass}`);
  }
  const problems = toolSetProblems(allowedTools, i.tools);
  if (problems.length > 0) throw new CccSessionToolPolicyRefusedError(problems);
  const policyId: CccSessionToolPolicy["policyId"] = linkedWriter
    ? "ccc-linked-writer-tools.v1"
    : probe ? `ccc-${i.roleClass}-probe-tools.v1` : `ccc-${i.roleClass}-tools.v1`;
  const policy: CccSessionToolPolicy = Object.freeze({
    policyId,
    allowedTools: Object.freeze([...allowedTools]),
    toolsetDigest: cccSessionToolsetDigest(i.tools),
    readRoots: Object.freeze(readRoots),
    writeRoots: Object.freeze(writeRoots),
    deniedNames: Object.freeze([...CCC_PLANNING_DENIED_NAMES]),
  });
  const key = policyContentKey(policy);
  if (key !== null) issuedPolicyKeys.add(key);
  return policy;
}

export function assertCccSessionToolSet(policy: CccSessionToolPolicy, finalTools: readonly ToolDefinition[]): void {
  const problems = toolSetProblems(policy.allowedTools, finalTools);
  if (problems.length === 0) {
    const digest = cccSessionToolsetDigest(finalTools);
    if (digest !== policy.toolsetDigest) {
      problems.push(`final toolset digest ${digest} is not the policy toolset digest ${policy.toolsetDigest}`);
    }
  }
  if (problems.length > 0) throw new CccSessionToolPolicyRefusedError(problems);
}

/**
 * createFnAgent's session tools under a tool policy, before the wrapper chain. Refuses any MCP server and any
 * builtin allowlist, tools allowlist or custom tool outside the policy, then builds every confined policy tool the
 * caller did not supply (a supplied one must carry the mark, so card C6 can pass wrapped probe tools).
 */
export function resolveCccPolicySessionTools(i: Readonly<{
  policy: CccSessionToolPolicy;
  confinement: CccConfinement;
  cwd: string;
  customTools: readonly ToolDefinition[];
  mcpServerNames: readonly string[];
  builtinToolsAllowlist: readonly string[] | undefined;
  toolsAllowlist: readonly string[] | undefined;
}>): ToolDefinition[] {
  const allowed = new Set(i.policy.allowedTools);
  const problems: string[] = [];
  const notIssued = notIssuedProblem(i.policy);
  if (notIssued !== null) problems.push(notIssued);
  if (i.mcpServerNames.length > 0) {
    problems.push(`MCP servers are refused in a tool-policy session (${i.mcpServerNames.join(", ")})`);
  }
  for (const name of i.builtinToolsAllowlist ?? []) {
    if (!allowed.has(name)) problems.push(`builtinToolsAllowlist entry ${name} is outside the policy`);
  }
  for (const entry of i.toolsAllowlist ?? []) {
    const name = entry.trim();
    if (name !== "" && !allowed.has(name)) problems.push(`toolsAllowlist entry ${name} is outside the policy`);
  }
  const supplied = new Map<string, ToolDefinition>();
  for (const tool of i.customTools) {
    if (!allowed.has(tool.name)) problems.push(`custom tool ${tool.name} is outside the policy`);
    else if (supplied.has(tool.name)) problems.push(`custom tool ${tool.name} is supplied more than once`);
    else if (CCC_CONFINED_TOOL_NAMES.has(tool.name) && !isCccConfinedTool(tool)) {
      problems.push(`custom tool ${tool.name} is not a Fusion confined tool (no CCC_CONFINED_TOOL_MARK)`);
    } else supplied.set(tool.name, tool);
  }
  if (problems.length > 0) throw new CccSessionToolPolicyRefusedError(problems);
  const built = createCccConfinedSessionTools({
    names: i.policy.allowedTools.filter((name) => CCC_CONFINED_TOOL_NAMES.has(name) && !supplied.has(name)),
    confinement: i.confinement,
    cwd: i.cwd,
    readRoots: i.policy.readRoots,
    deniedNames: i.policy.deniedNames,
  });
  return [...built, ...supplied.values()];
}

/**
 * createFnAgent's final check after the wrapper chain, for every policy (repair 2): assertCccSessionToolSet's names,
 * digest, marks and required tools, and a refusal of any policy buildCccSessionToolPolicy did not issue in this
 * process. Every problem is listed in one CccSessionToolPolicyRefusedError.
 */
export function assertCccPolicySessionFinalTools(policy: CccSessionToolPolicy, finalTools: readonly ToolDefinition[]): void {
  const notIssued = notIssuedProblem(policy);
  try {
    assertCccSessionToolSet(policy, finalTools);
  } catch (error) {
    if (notIssued !== null && error instanceof CccSessionToolPolicyRefusedError) {
      throw new CccSessionToolPolicyRefusedError([notIssued, ...error.problems]);
    }
    throw error;
  }
  if (notIssued !== null) throw new CccSessionToolPolicyRefusedError([notIssued]);
}
