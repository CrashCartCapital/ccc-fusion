import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  CccPlanningArtifactContent,
  CccPlanningArtifactKind,
  CccPlanningArtifactRef,
  CccPlanningArtifactStatus,
} from "@fusion/core";

/*
FNXC:CccSubmitArtifactTool 2026-10-14-21:10:
Card C2 (CONTRACT-v3 section 2.13). Authors and researchers publish through ccc_submit_artifact. The tool refuses a kind the session does not allow, a content schema it does not know, content its validator reports problems for, a status outside complete, infeasible, blocked and refused, and an unknown key; the store is never called for a refused submission. A model can only send text, so text content becomes its UTF-8 bytes here.
*/

const STATUSES: readonly CccPlanningArtifactStatus[] = Object.freeze(["complete", "infeasible", "blocked", "refused"]);
const SUBMISSION_KEYS: ReadonlySet<string> = new Set(["content", "contentSchema", "kind", "status"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function createCccSubmitArtifactTool(i: Readonly<{ allowedKinds: readonly CccPlanningArtifactKind[];
  contentSchemas: Readonly<Record<string, (value: unknown) => readonly string[]>>;   // validator -> problems
  onSubmit: (s: Readonly<{ kind: CccPlanningArtifactKind; contentSchema: string; content: CccPlanningArtifactContent;
    status: CccPlanningArtifactStatus }>) => Promise<CccPlanningArtifactRef> }>): ToolDefinition {
  const allowedKinds = [...new Set(i.allowedKinds)];
  const schemaNames = Object.keys(i.contentSchemas);
  if (allowedKinds.length === 0) throw new TypeError("ccc_submit_artifact needs at least one allowed kind");
  if (schemaNames.length === 0) throw new TypeError("ccc_submit_artifact needs at least one content schema");
  for (const name of schemaNames) {
    if (typeof i.contentSchemas[name] !== "function") throw new TypeError(`content schema ${name} must be a validator function`);
  }
  const kinds: ReadonlySet<string> = new Set(allowedKinds);

  const execute = async (params: unknown) => {
    if (!isPlainObject(params)) throw new Error("ccc_submit_artifact refused: the arguments must be an object");
    const problems = Object.keys(params).filter((key) => !SUBMISSION_KEYS.has(key)).map((key) => `unknown key ${key}`);
    const { kind, contentSchema, content, status } = params;
    if (typeof kind !== "string" || !kinds.has(kind)) problems.push(`kind ${String(kind)} is not allowed in this session`);
    const validator = typeof contentSchema === "string" && Object.hasOwn(i.contentSchemas, contentSchema)
      ? i.contentSchemas[contentSchema]
      : undefined;
    if (validator === undefined) problems.push(`contentSchema ${String(contentSchema)} is not known`);
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
      problems.push(`status must be one of ${STATUSES.join(", ")}`);
    }
    let submitted: CccPlanningArtifactContent | undefined;
    let validated: unknown;
    if (isPlainObject(content) && content.type === "json" && Object.keys(content).every((key) => key === "type" || key === "value")) {
      submitted = Object.freeze({ type: "json" as const, value: content.value });
      validated = content.value;
    } else if (isPlainObject(content) && content.type === "text" && typeof content.text === "string"
      && Object.keys(content).every((key) => key === "type" || key === "text")) {
      submitted = Object.freeze({ type: "text" as const, bytes: new TextEncoder().encode(content.text) });
      validated = content.text;
    } else {
      problems.push(`content must be {type: "json", value} or {type: "text", text}`);
    }
    if (problems.length === 0 && validator !== undefined) problems.push(...validator(validated));
    if (problems.length > 0 || submitted === undefined) throw new Error(`ccc_submit_artifact refused: ${problems.join("; ")}`);
    const ref = await i.onSubmit(Object.freeze({
      kind: kind as CccPlanningArtifactKind,
      contentSchema: contentSchema as string,
      content: submitted,
      status: status as CccPlanningArtifactStatus,
    }));
    return {
      content: [{ type: "text" as const, text: `Artifact recorded as ${ref.artifactKey}.` }],
      details: { artifactRef: ref },
    };
  };

  return {
    name: "ccc_submit_artifact",
    label: "Submit Planning Artifact",
    description: "Submit one planning artifact of an allowed kind, with content that matches its content schema. "
      + "Use {type: \"json\", value} for structured content and {type: \"text\", text} for prose.",
    executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.Union(allowedKinds.map((name) => Type.Literal(name))),
      contentSchema: Type.Union(schemaNames.map((name) => Type.Literal(name))),
      content: Type.Union([
        Type.Object({ type: Type.Literal("json"), value: Type.Unknown() }, { additionalProperties: false }),
        Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false }),
      ]),
      status: Type.Union(STATUSES.map((name) => Type.Literal(name))),
    }, { additionalProperties: false }),
    execute: (_toolCallId, params) => execute(params),
  };
}
