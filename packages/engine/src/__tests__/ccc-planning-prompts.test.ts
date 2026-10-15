/**
 * FNXC:CccPlanningPrompts 2026-10-14-18:50: card RP, PRD v3 section 4, D47.
 * Proof for the versioned role prompts of the FULL-v2 policy.
 *
 * What this file proves, by contract RED item:
 * 1. every FULL-v2 role (the three preflight probe roles included) has a versioned prompt and a stable digest;
 * 2. critic prompts name only `ccc_submit_verdict`, and the spec author is told to write one `decision_record` per objection input;
 * 3. no template interpolates anything but its declared packet inputs;
 * 4. the digest moves when one byte moves.
 *
 * Non-vacuity: every test that loops over roles first asserts the full 22-role fixture exists, so an empty prompt table
 * (the stub) fails on a behavioural assertion instead of passing over zero rows. Each refusal test has a control on the
 * same fixture that must pass. Pure functions only: no PostgreSQL, no network, no clock except where a test fakes it.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CCC_PLANNING_CONTENT_SCHEMAS,
  CCC_PLANNING_CONTENT_VALIDATORS,
  CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_MAX_CALLS_PER_ATTEMPT,
  CCC_PLANNING_PREFLIGHT_LINEAGES,
  CCC_PLANNING_PROBE_TOOL,
  CCC_PLANNING_ROLE_POLICY_FULL_V2,
  CCC_PLANNING_STAGE_KINDS,
  CCC_PLANNING_TOOLSETS,
  CccPlanningRefusal,
  canonicalCccPrdJson,
  type CccPlanningRoleId,
  type CccPlanningRoleSpec,
} from "@fusion/core";

import {
  CCC_PLANNING_PROMPT_SET_ID,
  CCC_PLANNING_PROMPT_TABLE,
  buildCccPlanningPromptTable,
  computeCccPlanningPromptSetDigest,
  cccPlanningPromptIdentity,
  renderCccPlanningPrompt,
  type CccPlanningPromptPacket,
  type CccPlanningPromptTable,
  type CccPlanningRolePrompt,
} from "../ccc-planning/prompts.js";
import {
  CCC_PLANNING_PROMPT_CONTENT_EXAMPLES,
  CCC_PLANNING_ROLE_PROMPT_SOURCES,
  type CccPlanningPromptVariantSource,
  type CccPlanningRolePromptSource,
} from "../ccc-planning/roles.js";

const POLICY_ROLES = CCC_PLANNING_ROLE_POLICY_FULL_V2.roles;
const ROLE_COUNT = 22;
const DIGEST_DOMAIN = "ccc-planning-prompt/v1";
const SET_DIGEST_DOMAIN = "ccc-planning-prompt-set/v1";
const HEX64 = /^[0-9a-f]{64}$/u;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;
const CCC_TOKEN = /\bccc_[a-z][a-z_]*\b/gu;
const BACKTICKED = /`([a-z][a-z0-9_]*)`/gu;
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(CCC_PLANNING_TOOLSETS).flat(),
  ...CCC_PLANNING_LINKED_WRITER_TOOLSET,
  CCC_PLANNING_PROBE_TOOL,
]);
const PROBE_TOOL_BY_PROBE: Readonly<Record<string, string | null>> = {
  identity: null,
  "strict-echo": "ccc_probe_echo",
  "exact-edit": "edit",
  "verdict-shape": "ccc_submit_verdict",
  "citation-read": "ccc_citation_read",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The full 22-role fixture; fails (behaviourally) while the source list is empty. */
function sources(): readonly CccPlanningRolePromptSource[] {
  expect(CCC_PLANNING_ROLE_PROMPT_SOURCES.length, "prompt source count").toBe(ROLE_COUNT);
  expect(POLICY_ROLES.length, "FULL-v2 role count").toBe(ROLE_COUNT);
  return CCC_PLANNING_ROLE_PROMPT_SOURCES;
}

function promptFor(roleId: CccPlanningRoleId, table: CccPlanningPromptTable = CCC_PLANNING_PROMPT_TABLE): CccPlanningRolePrompt {
  const found = table.prompts.find((prompt) => prompt.roleId === roleId);
  expect(found, `prompt for ${roleId}`).toBeDefined();
  return found as CccPlanningRolePrompt;
}

function specFor(roleId: CccPlanningRoleId): CccPlanningRoleSpec {
  const found = POLICY_ROLES.find((role) => role.roleId === roleId);
  expect(found, `policy role ${roleId}`).toBeDefined();
  return found as CccPlanningRoleSpec;
}

function allVariants(): { spec: CccPlanningRoleSpec; prompt: CccPlanningRolePrompt; variant: CccPlanningPromptVariantSource }[] {
  expect(CCC_PLANNING_PROMPT_TABLE.prompts.length, "prompt table size").toBe(ROLE_COUNT);
  return POLICY_ROLES.flatMap((spec) => {
    const prompt = promptFor(spec.roleId);
    return prompt.variants.map((variant) => ({ spec, prompt, variant }));
  });
}

function mainTemplate(roleId: CccPlanningRoleId): string {
  const prompt = promptFor(roleId);
  const main = prompt.variants.find((variant) => variant.name === "main");
  expect(main, `${roleId} main variant`).toBeDefined();
  return (main as CccPlanningPromptVariantSource).template;
}

function mapVariant(
  list: readonly CccPlanningRolePromptSource[],
  roleId: CccPlanningRoleId,
  variantName: string,
  change: (variant: CccPlanningPromptVariantSource) => CccPlanningPromptVariantSource,
): CccPlanningRolePromptSource[] {
  return list.map((source) =>
    source.roleId !== roleId
      ? source
      : { ...source, variants: source.variants.map((variant) => (variant.name === variantName ? change(variant) : variant)) });
}

function withTemplate(
  list: readonly CccPlanningRolePromptSource[],
  roleId: CccPlanningRoleId,
  variantName: string,
  template: string,
): CccPlanningRolePromptSource[] {
  return mapVariant(list, roleId, variantName, (variant) => ({ ...variant, template }));
}

function replaceByteAt(text: string, index: number): string {
  const next = text[index] === "a" ? "b" : "a";
  return `${text.slice(0, index)}${next}${text.slice(index + 1)}`;
}

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

function cccTokens(text: string): string[] {
  return [...new Set(text.match(CCC_TOKEN) ?? [])].sort();
}

function namedTools(text: string): string[] {
  return [...new Set([...text.matchAll(BACKTICKED)].map((match) => match[1] as string).filter((name) => KNOWN_TOOLS.has(name)))].sort();
}

function sentinelPacket(variant: CccPlanningPromptVariantSource): CccPlanningPromptPacket {
  const packet: Record<string, string | readonly string[]> = {};
  for (const input of variant.inputs) {
    packet[input.name] = input.kind === "list" ? [`${input.name}-item-1`, `${input.name}-item-2`] : `value-of-${input.name}`;
  }
  return packet;
}

function expandOnce(variant: CccPlanningPromptVariantSource, packet: CccPlanningPromptPacket): string {
  const kinds = new Map(variant.inputs.map((input) => [input.name, input.kind] as const));
  return variant.template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu, (_whole, name: string) => {
    const value = packet[name];
    if (kinds.get(name) === "list") {
      const items = value as readonly string[];
      return items.length === 0 ? "- (none)" : items.map((item) => `- ${item}`).join("\n");
    }
    return value as string;
  });
}

function allowedTools(spec: CccPlanningRoleSpec): ReadonlySet<string> {
  const base = spec.roleId === "implementation-writer" ? CCC_PLANNING_LINKED_WRITER_TOOLSET : CCC_PLANNING_TOOLSETS[spec.roleClass];
  return new Set([...base, ...(spec.counting === "probe" ? [CCC_PLANNING_PROBE_TOOL] : [])]);
}

function documentedDigest(source: CccPlanningRolePromptSource): string {
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

describe("ccc planning role prompts", () => {
  it("covers every FULL-v2 role and probe role with a versioned prompt and a 64-hex digest", () => {
    const list = sources();
    expect(CCC_PLANNING_PROMPT_TABLE.promptSetId).toBe(CCC_PLANNING_PROMPT_SET_ID);
    expect(CCC_PLANNING_PROMPT_TABLE.prompts.map((prompt) => prompt.roleId).sort()).toEqual(
      POLICY_ROLES.map((role) => role.roleId).sort(),
    );
    expect(list.map((source) => source.roleId).sort()).toEqual(POLICY_ROLES.map((role) => role.roleId).sort());
    expect(POLICY_ROLES.filter((role) => role.counting === "probe").map((role) => role.roleId).sort()).toEqual([
      "preflight-critic",
      "preflight-researcher",
      "preflight-writer",
    ]);
    for (const spec of POLICY_ROLES) {
      const prompt = promptFor(spec.roleId);
      expect(prompt.promptVersion, spec.roleId).toBe(`ccc-planning.prompt.${spec.roleId}.v1`);
      expect(prompt.digest, spec.roleId).toMatch(HEX64);
    }
    expect(new Set(CCC_PLANNING_PROMPT_TABLE.prompts.map((prompt) => prompt.digest)).size).toBe(ROLE_COUNT);
  });

  it("gives each probe role one prompt per preflight probe and every other role a single main prompt", () => {
    sources();
    expect(CCC_PLANNING_PREFLIGHT_LINEAGES.length).toBe(3);
    for (const lineage of CCC_PLANNING_PREFLIGHT_LINEAGES) {
      expect(promptFor(lineage.roleId as CccPlanningRoleId).variants.map((variant) => variant.name), lineage.roleId).toEqual([...lineage.probes]);
    }
    const probeRoles = new Set<string>(CCC_PLANNING_PREFLIGHT_LINEAGES.map((lineage) => lineage.roleId));
    for (const spec of POLICY_ROLES.filter((role) => !probeRoles.has(role.roleId))) {
      expect(promptFor(spec.roleId).variants.map((variant) => variant.name), spec.roleId).toEqual(["main"]);
    }
  });

  it("derives each digest from the version, role id, inputs and template with a documented sha256 form", () => {
    const list = sources();
    for (const source of list) {
      expect(promptFor(source.roleId).digest, source.roleId).toBe(documentedDigest(source));
    }
  });

  it("keeps a role digest equal across two builds of the table and reports it through the identity lookup", () => {
    const list = sources();
    const first = buildCccPlanningPromptTable(list);
    const second = buildCccPlanningPromptTable(list);
    expect(first.prompts.length).toBe(ROLE_COUNT);
    for (const spec of POLICY_ROLES) {
      expect(promptFor(spec.roleId, first).digest, spec.roleId).toBe(promptFor(spec.roleId, second).digest);
      expect(promptFor(spec.roleId, first).digest, spec.roleId).toBe(promptFor(spec.roleId).digest);
      expect(cccPlanningPromptIdentity(spec.roleId), spec.roleId).toEqual({
        promptVersion: promptFor(spec.roleId).promptVersion,
        promptDigest: promptFor(spec.roleId).digest,
      });
    }
    expect(() => cccPlanningPromptIdentity("not-a-role" as CccPlanningRoleId)).toThrow(CccPlanningRefusal);
  });

  it("changes a role digest when one byte of any of its templates changes and leaves every other digest alone", () => {
    const list = sources();
    const baseline = new Map(buildCccPlanningPromptTable(list).prompts.map((prompt) => [prompt.roleId, prompt.digest] as const));
    expect(baseline.size).toBe(ROLE_COUNT);
    let mutations = 0;
    for (const source of list) {
      for (const variant of source.variants) {
        const positions = [0, variant.template.indexOf(" ", 40), variant.template.length - 1];
        for (const index of positions) {
          expect(index, `${source.roleId}/${variant.name} position`).toBeGreaterThanOrEqual(0);
          const mutated = buildCccPlanningPromptTable(withTemplate(list, source.roleId, variant.name, replaceByteAt(variant.template, index)));
          mutations += 1;
          for (const prompt of mutated.prompts) {
            if (prompt.roleId === source.roleId) {
              expect(prompt.digest, `${source.roleId}/${variant.name}@${index}`).not.toBe(baseline.get(prompt.roleId));
            } else {
              expect(prompt.digest, `${prompt.roleId} beside ${source.roleId}/${variant.name}`).toBe(baseline.get(prompt.roleId));
            }
          }
        }
      }
    }
    expect(mutations).toBeGreaterThanOrEqual(ROLE_COUNT * 3);
  });

  it("changes a role digest when its version or a declared input changes", () => {
    const list = sources();
    const baseline = promptFor("spec-author").digest;
    const bumped = list.map((source) => (source.roleId === "spec-author" ? { ...source, promptVersion: "ccc-planning.prompt.spec-author.v2" } : source));
    expect(promptFor("spec-author", buildCccPlanningPromptTable(bumped)).digest).not.toBe(baseline);
    const reworded = mapVariant(list, "spec-author", "main", (variant) => ({
      ...variant,
      inputs: variant.inputs.map((input, index) => (index === 0 ? { ...input, about: `${input.about} (changed)` } : input)),
    }));
    expect(promptFor("spec-author", buildCccPlanningPromptTable(reworded)).digest).not.toBe(baseline);
    const retyped = mapVariant(list, "spec-author", "main", (variant) => ({
      ...variant,
      inputs: variant.inputs.map((input) => (input.name === "objections" ? { ...input, kind: "text" as const } : input)),
    }));
    expect(promptFor("spec-author", buildCccPlanningPromptTable(retyped)).digest).not.toBe(baseline);
  });

  it("names only ccc_submit_verdict in critic prompts, except the probe critic that also exercises the probe tool", () => {
    const critics = POLICY_ROLES.filter((role) => role.roleClass === "critic");
    expect(critics.length).toBe(10);
    for (const spec of critics) {
      for (const variant of promptFor(spec.roleId).variants) {
        const expected = spec.counting === "probe"
          ? [PROBE_TOOL_BY_PROBE[variant.name]].filter((name): name is string => typeof name === "string" && name.startsWith("ccc_"))
          : ["ccc_submit_verdict"];
        expect(cccTokens(variant.template), `${spec.roleId}/${variant.name}`).toEqual(expected);
      }
    }
    // Control on the same table: author roles name the artifact tool and never the verdict tool.
    for (const spec of POLICY_ROLES.filter((role) => role.roleClass === "author")) {
      expect(cccTokens(mainTemplate(spec.roleId)), spec.roleId).toEqual(["ccc_submit_artifact"]);
    }
  });

  it("names a tool in backticks only when the role's closed toolset allows it", () => {
    let mentions = 0;
    for (const { spec, variant } of allVariants()) {
      const allowed = allowedTools(spec);
      for (const name of namedTools(variant.template)) {
        mentions += 1;
        expect(allowed.has(name), `${spec.roleId}/${variant.name} names ${name}`).toBe(true);
      }
    }
    expect(mentions).toBeGreaterThan(20);
    expect(cccTokens(mainTemplate("verifier-author"))).toEqual([]);
    for (const spec of POLICY_ROLES.filter((role) => role.roleClass === "researcher" && role.counting !== "probe")) {
      expect(cccTokens(mainTemplate(spec.roleId)), spec.roleId).toContain("ccc_submit_artifact");
    }
  });

  it("tells author and researcher roles to submit only artifact kinds their stage publishes", () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      "intent-assessor": ["acceptance_cases", "decision_request"],
      researcher: ["research_evidence"],
      "extraction-leaf": ["extraction"],
      "source-verifier": ["source_verification"],
      "designer-a": ["design_alternative"],
      "designer-b": ["design_alternative"],
      "spec-author": ["decision_record", "final_prd", "requirement_map", "technical_annex"],
      "execution-planner": ["routing_plan", "task_plan"],
    };
    const controllerProduced = new Set(["objection", "model_receipt", "citation"]);
    let checked = 0;
    for (const spec of POLICY_ROLES.filter((role) => (role.roleClass === "author" || role.roleClass === "researcher") && role.counting !== "probe")) {
      const line = /The only kinds you may submit are: ([^\n]+)\./u.exec(mainTemplate(spec.roleId));
      expect(line, `${spec.roleId} kinds line`).not.toBeNull();
      const kinds = [...(line as RegExpExecArray)[1]!.matchAll(BACKTICKED)].map((match) => match[1] as string).sort();
      expect(kinds, spec.roleId).toEqual([...(expected[spec.roleId] ?? [])].sort());
      const publishable = new Set<string>([
        ...CCC_PLANNING_STAGE_KINDS[spec.stageId as keyof typeof CCC_PLANNING_STAGE_KINDS],
        ...(spec.roleClass === "author" ? CCC_PLANNING_STAGE_KINDS.repair : []),
      ]);
      for (const kind of kinds) {
        expect(publishable.has(kind), `${spec.roleId} may publish ${kind}`).toBe(true);
        expect(controllerProduced.has(kind), `${spec.roleId} must not submit ${kind}`).toBe(false);
      }
      checked += 1;
    }
    expect(checked).toBe(Object.keys(expected).length);
    for (const spec of POLICY_ROLES.filter((role) => role.roleClass === "critic" || role.roleClass === "writer")) {
      for (const variant of promptFor(spec.roleId).variants) {
        expect(variant.template, `${spec.roleId}/${variant.name}`).not.toMatch(/The only kinds you may submit are:/u);
      }
    }
  });

  it("requires one decision_record per objection input in the spec author prompt and in no other prompt", () => {
    const template = mainTemplate("spec-author");
    expect(template).toMatch(/Submit exactly one `decision_record` for each objection in the `objections` input/u);
    expect(template).toMatch(/The number of `decision_record` artifacts you submit must equal the number of objections/u);
    for (const field of ["objectionKey", "proposal", "evidence", "objection", "discriminatingObservation", "disposition", "remainingUncertainty"]) {
      expect(template, field).toContain(`\`${field}\``);
    }
    const main = promptFor("spec-author").variants[0]!;
    const objections = main.inputs.find((input) => input.name === "objections");
    expect(objections?.kind).toBe("list");
    const keys = ["cccplan-r001-design-review-obj1-v01", "cccplan-r001-review-obj2-v01", "cccplan-r001-verifier-obj3-v01"];
    const rendered = renderCccPlanningPrompt("spec-author", { ...sentinelPacket(main), objections: keys }).prompt;
    for (const key of keys) expect(rendered, key).toContain(`\n- ${key}\n`);
    // Control: no other role is told to submit a decision_record.
    for (const { spec, variant } of allVariants()) {
      if (spec.roleId === "spec-author") continue;
      expect(variant.template, `${spec.roleId}/${variant.name}`).not.toMatch(/Submit exactly one `decision_record`/u);
      expect(variant.template, `${spec.roleId}/${variant.name}`).not.toMatch(/must equal the number of objections/u);
    }
  });

  it("embeds content examples that pass the core schema validators, and the validators refuse a corrupted copy", () => {
    const examples = Object.entries(CCC_PLANNING_PROMPT_CONTENT_EXAMPLES);
    expect(examples.length).toBe(6);
    const owners: Readonly<Record<string, CccPlanningRoleId>> = {
      [CCC_PLANNING_CONTENT_SCHEMAS.acceptanceCases]: "intent-assessor",
      [CCC_PLANNING_CONTENT_SCHEMAS.decisionRequest]: "intent-assessor",
      [CCC_PLANNING_CONTENT_SCHEMAS.requirementMap]: "spec-author",
      [CCC_PLANNING_CONTENT_SCHEMAS.decisionRecord]: "spec-author",
      [CCC_PLANNING_CONTENT_SCHEMAS.taskPlan]: "execution-planner",
      [CCC_PLANNING_CONTENT_SCHEMAS.routingPlan]: "execution-planner",
    };
    for (const [schemaId, example] of examples) {
      const validator = CCC_PLANNING_CONTENT_VALIDATORS[schemaId];
      expect(validator, schemaId).toBeDefined();
      expect(validator!(example), schemaId).toEqual([]);
      expect(validator!({ ...(example as Record<string, unknown>), unexpectedKey: 1 }).length, `${schemaId} corrupted`).toBeGreaterThan(0);
      const owner = owners[schemaId];
      expect(owner, `${schemaId} owner`).toBeDefined();
      const template = mainTemplate(owner as CccPlanningRoleId);
      expect(template, schemaId).toContain(JSON.stringify(example, null, 2));
      expect(template, schemaId).toContain(schemaId);
    }
  });

  it("declares every template placeholder as an input, uses each input once, and has no stray braces", () => {
    let variants = 0;
    for (const { spec, variant } of allVariants()) {
      variants += 1;
      const declared = variant.inputs.map((input) => input.name);
      expect(new Set(declared).size, `${spec.roleId}/${variant.name} duplicate inputs`).toBe(declared.length);
      expect(placeholdersOf(variant.template).sort(), `${spec.roleId}/${variant.name}`).toEqual([...declared].sort());
      for (const name of declared) expect(name, `${spec.roleId}/${variant.name}`).toMatch(/^[A-Za-z][A-Za-z0-9]*$/u);
      const withoutPlaceholders = variant.template.replace(PLACEHOLDER, "");
      expect(withoutPlaceholders, `${spec.roleId}/${variant.name} stray braces`).not.toMatch(/\{\{|\}\}/u);
      expect(variant.template, `${spec.roleId}/${variant.name} JavaScript placeholder`).not.toContain("${");
    }
    expect(variants).toBeGreaterThanOrEqual(28);
  });

  it("refuses at build time an undeclared placeholder, an unused input, a stray brace pair and a JavaScript placeholder", () => {
    const list = sources();
    const reviewer = list.find((source) => source.roleId === "acceptance-reviewer")!;
    const template = reviewer.variants[0]!.template;
    expect(placeholdersOf(template)).toContain("requestText");
    // Control: the unchanged sources build.
    expect(buildCccPlanningPromptTable(list).prompts.length).toBe(ROLE_COUNT);
    const broken: readonly (readonly [string, string])[] = [
      ["undeclared placeholder", `${template}\n{{surprise}}`],
      ["unused declared input", template.replace("{{requestText}}", "gone")],
      ["input used twice", `${template}\n{{requestText}}`],
      ["stray opening braces", `${template}\n{{`],
      ["spaced placeholder", template.replace("{{requestText}}", "{{ requestText }}")],
      ["javascript placeholder", `${template}\n\${requestText}`],
    ];
    for (const [label, text] of broken) {
      const attempt = () => buildCccPlanningPromptTable(withTemplate(list, "acceptance-reviewer", "main", text));
      expect(attempt, label).toThrow(CccPlanningRefusal);
      expect(attempt, label).toThrow(/CCC_PLANNING_INTERNAL_ERROR/u);
    }
  });

  it("refuses at build time duplicate or unknown roles and a version that does not name its role", () => {
    const list = sources();
    expect(buildCccPlanningPromptTable(list).prompts.length).toBe(ROLE_COUNT);
    expect(() => buildCccPlanningPromptTable([...list, list[0]!])).toThrow(CccPlanningRefusal);
    expect(() => buildCccPlanningPromptTable([...list, { ...list[0]!, roleId: "not-a-role" as CccPlanningRoleId }])).toThrow(CccPlanningRefusal);
    for (const version of ["ccc-planning.prompt.designer-b.v1", "v1", "ccc-planning.prompt.spec-author.v0", "ccc-planning.prompt.spec-author.v1 "]) {
      const wrong = list.map((source) => (source.roleId === "spec-author" ? { ...source, promptVersion: version } : source));
      expect(() => buildCccPlanningPromptTable(wrong), version).toThrow(CccPlanningRefusal);
    }
    const noVariants = list.map((source) => (source.roleId === "spec-author" ? { ...source, variants: [] } : source));
    expect(() => buildCccPlanningPromptTable(noVariants)).toThrow(CccPlanningRefusal);
    // A table that leaves out any one policy role is refused, so the policy is always fully covered.
    const withoutJudge = list.filter((source) => source.roleId !== "final-judge");
    expect(withoutJudge.length).toBe(ROLE_COUNT - 1);
    expect(() => buildCccPlanningPromptTable(withoutJudge)).toThrow(/final-judge/u);
  });

  it("renders each prompt as its template with only the declared inputs filled in", () => {
    for (const { spec, prompt, variant } of allVariants()) {
      const packet = sentinelPacket(variant);
      const rendered = renderCccPlanningPrompt(spec.roleId, packet, variant.name);
      expect(rendered.prompt, `${spec.roleId}/${variant.name}`).toBe(expandOnce(variant, packet));
      expect(rendered.roleId).toBe(spec.roleId);
      expect(rendered.variant).toBe(variant.name);
      expect(rendered.promptVersion).toBe(prompt.promptVersion);
      expect(rendered.promptDigest).toBe(prompt.digest);
      expect(rendered.prompt).not.toMatch(/\{\{|\}\}/u);
      for (const input of variant.inputs) {
        const needle = input.kind === "list" ? `- ${input.name}-item-1\n- ${input.name}-item-2` : `value-of-${input.name}`;
        expect(rendered.prompt, `${spec.roleId}/${variant.name}/${input.name}`).toContain(needle);
      }
    }
  });

  it("renders byte-identical output under another clock, environment and random source", () => {
    const renderAll = () => allVariants().map(({ spec, variant }) => renderCccPlanningPrompt(spec.roleId, sentinelPacket(variant), variant.name).prompt);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = renderAll();
    expect(first.length).toBeGreaterThanOrEqual(28);
    vi.setSystemTime(new Date("2031-06-30T12:34:56.789Z"));
    vi.stubEnv("USER", "someone-else");
    vi.stubEnv("HOME", "/somewhere/else");
    vi.stubEnv("TZ", "Asia/Tokyo");
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    expect(renderAll()).toEqual(first);
  });

  it("refuses a packet with an undeclared key, a missing key or a malformed value, and an unknown role or variant", () => {
    const reviewer = promptFor("acceptance-reviewer").variants[0]!;
    const good = sentinelPacket(reviewer);
    // Control: the complete packet renders.
    expect(renderCccPlanningPrompt("acceptance-reviewer", good).prompt.length).toBeGreaterThan(100);
    const attempts: readonly (readonly [string, CccPlanningPromptPacket, RegExp])[] = [
      ["undeclared key", { ...good, surprise: "x" }, /surprise/u],
      ["missing key", { requestText: "only the request" }, /candidate/u],
      ["list given a string", { ...good, candidate: "not a list" }, /candidate/u],
      ["text given an array", { ...good, requestText: ["a"] }, /requestText/u],
      ["empty text", { ...good, requestText: "" }, /requestText/u],
      ["blank text", { ...good, requestText: "   \n" }, /requestText/u],
      ["NUL in text", { ...good, requestText: "a\u0000b" }, /requestText/u],
      ["newline in a list item", { ...good, candidate: ["one\ntwo"] }, /candidate/u],
      ["empty list item", { ...good, candidate: [""] }, /candidate/u],
      ["non-string list item", { ...good, candidate: [1 as unknown as string] }, /candidate/u],
    ];
    for (const [label, packet, pattern] of attempts) {
      const attempt = () => renderCccPlanningPrompt("acceptance-reviewer", packet);
      expect(attempt, label).toThrow(CccPlanningRefusal);
      expect(attempt, label).toThrow(pattern);
    }
    // An empty list is a valid packet value and renders as an explicit none.
    expect(renderCccPlanningPrompt("acceptance-reviewer", { ...good, candidate: [] }).prompt).toContain("\n- (none)\n");
    expect(() => renderCccPlanningPrompt("not-a-role" as CccPlanningRoleId, {})).toThrow(CccPlanningRefusal);
    expect(() => renderCccPlanningPrompt("acceptance-reviewer", good, "nope")).toThrow(/nope/u);
    // A probe role has no main prompt, so the variant must be named; the named one renders.
    expect(() => renderCccPlanningPrompt("preflight-writer", {})).toThrow(CccPlanningRefusal);
    expect(renderCccPlanningPrompt("preflight-writer", {}, "identity").prompt.length).toBeGreaterThan(10);
  });

  it("inserts a packet value that looks like a placeholder literally instead of expanding it", () => {
    const reviewer = promptFor("acceptance-reviewer").variants[0]!;
    const packet = { ...sentinelPacket(reviewer), requestText: "{{candidate}} and {{surprise}} and $& $1 $$" };
    const rendered = renderCccPlanningPrompt("acceptance-reviewer", packet).prompt;
    expect(rendered).toBe(expandOnce(reviewer, packet));
    expect(rendered.split("{{candidate}}").length - 1).toBe(1);
    expect(rendered).toContain("{{surprise}}");
    expect(rendered).toContain("and $& $1 $$");
    expect(rendered).toContain("candidate-item-1");
  });

  it("gives the prompt set digest a documented form that ignores source order and moves with one byte", () => {
    const list = sources();
    const entries = list
      .map((source) => ({ role: source.roleId, promptVersion: source.promptVersion, promptSha256: documentedDigest(source) }))
      .sort((left, right) => (left.role < right.role ? -1 : left.role > right.role ? 1 : 0));
    const documented = sha256(`${SET_DIGEST_DOMAIN}\0${canonicalCccPrdJson(entries)}`);
    const table = buildCccPlanningPromptTable(list);
    expect(computeCccPlanningPromptSetDigest(table)).toBe(documented);
    expect(computeCccPlanningPromptSetDigest()).toBe(documented);
    expect(computeCccPlanningPromptSetDigest(buildCccPlanningPromptTable([...list].reverse()))).toBe(documented);
    const spec = list.find((source) => source.roleId === "task-reviewer")!;
    const moved = buildCccPlanningPromptTable(withTemplate(list, "task-reviewer", "main", replaceByteAt(spec.variants[0]!.template, 0)));
    expect(computeCccPlanningPromptSetDigest(moved)).not.toBe(documented);
    expect(computeCccPlanningPromptSetDigest(moved)).toMatch(HEX64);
  });

  it("keeps the two designers blind to each other and gives each design reviewer exactly one design input", () => {
    const names = (roleId: CccPlanningRoleId) => promptFor(roleId).variants[0]!.inputs.map((input) => input.name);
    expect(names("designer-a")).toEqual(names("designer-b"));
    expect(names("designer-a").length).toBeGreaterThan(0);
    for (const roleId of ["designer-a", "designer-b"] as const) {
      expect(names(roleId).filter((name) => /design/iu.test(name)), roleId).toEqual([]);
      expect(mainTemplate(roleId), roleId).toMatch(/not shown any other design/u);
    }
    for (const roleId of ["design-a-reviewer", "design-b-reviewer"] as const) {
      expect(names(roleId).filter((name) => name === "design"), roleId).toEqual(["design"]);
      expect(names(roleId).filter((name) => /design/iu.test(name)), roleId).toEqual(["design"]);
    }
    expect(names("spec-author")).toContain("designAlternatives");
  });

  it("makes each probe prompt exercise exactly one tool and end after one call", () => {
    let probes = 0;
    for (const lineage of CCC_PLANNING_PREFLIGHT_LINEAGES) {
      const prompt = promptFor(lineage.roleId as CccPlanningRoleId);
      for (const variant of prompt.variants) {
        probes += 1;
        const tool = PROBE_TOOL_BY_PROBE[variant.name];
        expect(tool, `${lineage.roleId}/${variant.name} is a known probe`).not.toBeUndefined();
        expect(namedTools(variant.template), `${lineage.roleId}/${variant.name}`).toEqual(tool === null ? [] : [tool]);
        if (tool === null) {
          expect(variant.template, `${lineage.roleId}/${variant.name}`).toMatch(/Do not call any tool\./u);
          expect(variant.inputs, `${lineage.roleId}/${variant.name}`).toEqual([]);
        } else {
          expect(variant.template, `${lineage.roleId}/${variant.name}`).toMatch(/exactly once/u);
          expect(variant.template, `${lineage.roleId}/${variant.name}`).toMatch(/Make no other tool call\./u);
        }
      }
    }
    expect(probes).toBe(9);
  });

  it("sizes planner tasks to the call cap and names fn_complete_phase only in the implementation writer prompt", () => {
    const cap = String(CCC_PLANNING_MAX_CALLS_PER_ATTEMPT);
    expect(mainTemplate("execution-planner")).toContain(`${cap} model calls`);
    expect(mainTemplate("implementation-writer")).toContain(`${cap} model calls`);
    expect(mainTemplate("implementation-writer")).toContain("`fn_complete_phase`");
    expect(mainTemplate("implementation-writer")).toMatch(/by itself/u);
    for (const { spec, variant } of allVariants()) {
      if (spec.roleId === "implementation-writer") continue;
      expect(variant.template, `${spec.roleId}/${variant.name}`).not.toContain("fn_complete_phase");
    }
  });

  it("keeps every template ASCII with LF line ends and shows critics no earlier verdict", () => {
    for (const { spec, variant } of allVariants()) {
      expect(variant.template, `${spec.roleId}/${variant.name}`).toMatch(/^[\n -~]+$/u);
      for (const input of variant.inputs) expect(input.about, `${spec.roleId}/${variant.name}/${input.name}`).toMatch(/^[ -~]+$/u);
    }
    for (const spec of POLICY_ROLES.filter((role) => role.roleClass === "critic" && role.counting !== "probe")) {
      expect(mainTemplate(spec.roleId), spec.roleId).toMatch(/You are shown no earlier verdict/u);
    }
  });
});
