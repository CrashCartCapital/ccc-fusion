import { createHash } from "node:crypto";
import {
  canonicalCccPrdJson,
  createCccPrdSpanFromBytes,
  type CccPrdAcceptanceSourceSpan,
} from "@fusion/core";
import { CccPrdCustodyError } from "./custody.js";

export type ParsedCccPrdAcceptanceClause = {
  id: string;
  requirementId: string;
  text: string;
  span: CccPrdAcceptanceSourceSpan;
};

export type ParsedCccPrdAcceptanceDisposition = {
  clauseId: string;
  requirementId: string;
  kind: "deferred" | "excluded" | "unresolved";
  reason: string;
  span: CccPrdAcceptanceSourceSpan;
};

export type CccPrdAcceptanceClauseInventory = {
  clauses: ParsedCccPrdAcceptanceClause[];
  dispositions: ParsedCccPrdAcceptanceDisposition[];
};

export type CccPrdProposalAcceptanceClauseLink = {
  id: string;
  requirementId: string;
  text: string;
  proofIds: string[];
  sourceRefs: Array<{ path: string; exactQuote: string }>;
};

export type CccPrdProposalAcceptanceDispositionLink = {
  clauseId: string;
  requirementId: string;
  kind: "deferred" | "excluded" | "unresolved";
  reason: string;
  sourceRefs: Array<{ path: string; exactQuote: string }>;
};

export type ReconciledCccPrdAcceptanceRequirement = {
  requirementId: string;
  acceptanceClauses: Array<Omit<CccPrdProposalAcceptanceClauseLink, "sourceRefs"> & {
    span: CccPrdAcceptanceSourceSpan;
  }>;
  acceptanceDispositions: Array<Omit<CccPrdProposalAcceptanceDispositionLink, "sourceRefs"> & {
    span: CccPrdAcceptanceSourceSpan;
  }>;
};

type SourceLine = {
  text: string;
  byteStart: number;
  contentEnd: number;
};

const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const REQUIREMENT_HEADING = /^### Requirement ([A-Za-z0-9][A-Za-z0-9._:-]{0,191})$/u;
const CLAUSE_LINE = /^- \[(AC-[A-Za-z0-9][A-Za-z0-9._:-]{0,188})\] (.+)$/u;
const DISPOSITION_LINE = /^- \[(AC-[A-Za-z0-9][A-Za-z0-9._:-]{0,188})\] (deferred|excluded|unresolved): (.+)$/u;
const ACCEPTANCE_CLAUSES_HEADING = "#### Acceptance clauses";
const ACCEPTANCE_DISPOSITIONS_HEADING = "#### Acceptance dispositions";

function malformed(message: string): never {
  throw new CccPrdCustodyError("CCC_PRD_ACCEPTANCE_CLAUSE_MALFORMED", message);
}

function decodeLines(bytes: Buffer): SourceLine[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    malformed("acceptance source is not valid UTF-8");
  }
  const lines: SourceLine[] = [];
  let byteStart = 0;
  while (byteStart < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, byteStart);
    const byteEnd = newline < 0 ? bytes.byteLength : newline + 1;
    const contentEnd = newline < 0
      ? byteEnd
      : newline > byteStart && bytes[newline - 1] === 0x0d
        ? newline - 1
        : newline;
    lines.push({
      text: bytes.subarray(byteStart, contentEnd).toString("utf8"),
      byteStart,
      contentEnd,
    });
    byteStart = byteEnd;
  }
  if (bytes.byteLength === 0 && decoded.length === 0) return [];
  return lines;
}

function exactSpan(
  sourcePath: string,
  sourceBytes: Buffer,
  byteStart: number,
  byteEnd: number,
): CccPrdAcceptanceSourceSpan {
  const excerpt = sourceBytes.subarray(byteStart, byteEnd);
  return {
    ...createCccPrdSpanFromBytes(sourcePath, sourceBytes, byteStart, byteEnd),
    excerptSha256: createHash("sha256").update(excerpt).digest("hex"),
  };
}

function assertCanonicalRequirementId(requirementId: string): void {
  if (!CANONICAL_ID.test(requirementId) || requirementId.startsWith("AC-")) {
    malformed(`requirement heading has non-canonical id ${requirementId}`);
  }
}

function assertClauseOwner(clauseId: string, requirementId: string): void {
  const suffix = clauseId.slice(`AC-${requirementId}-`.length);
  if (
    !CANONICAL_ID.test(clauseId)
    || !clauseId.startsWith(`AC-${requirementId}-`)
    || suffix.length === 0
    || !CANONICAL_ID.test(suffix)
  ) {
    malformed(`acceptance clause ${clauseId} does not belong to requirement ${requirementId}`);
  }
}

function looksLikeAcceptanceBullet(text: string): boolean {
  return /^\s*[-*+]\s+\[AC-/u.test(text);
}

type ParsedInventoryWithRequirements = CccPrdAcceptanceClauseInventory & {
  requirementIds: string[];
};

function parseInventory(input: {
  sourcePath: string;
  sourceBytes: Buffer;
}): ParsedInventoryWithRequirements {

  const clauses: ParsedCccPrdAcceptanceClause[] = [];
  const dispositions: ParsedCccPrdAcceptanceDisposition[] = [];
  const lines = decodeLines(input.sourceBytes);
  const requirementIds = new Set<string>();
  const clauseIds = new Set<string>();
  const dispositionIds = new Set<string>();
  const acceptanceHeadings = new Set<string>();
  let requirementId: string | undefined;
  let subsection: "clauses" | "dispositions" | undefined;

  for (const line of lines) {
    const requirementMatch = line.text.match(REQUIREMENT_HEADING);
    if (requirementMatch) {
      requirementId = requirementMatch[1]!;
      assertCanonicalRequirementId(requirementId);
      if (requirementIds.has(requirementId)) {
        malformed(`duplicate requirement heading ${requirementId}`);
      }
      requirementIds.add(requirementId);
      subsection = undefined;
      continue;
    }

    if (line.text.startsWith("### Requirement ")) {
      requirementId = undefined;
      subsection = undefined;
      continue;
    }

    if (line.text === ACCEPTANCE_CLAUSES_HEADING || line.text === ACCEPTANCE_DISPOSITIONS_HEADING) {
      if (!requirementId) malformed(`${line.text} is outside a canonical requirement`);
      const key = `${requirementId}\0${line.text}`;
      if (acceptanceHeadings.has(key)) malformed(`duplicate ${line.text} heading for ${requirementId}`);
      acceptanceHeadings.add(key);
      subsection = line.text === ACCEPTANCE_CLAUSES_HEADING ? "clauses" : "dispositions";
      continue;
    }

    if (/^#{1,6}\s/u.test(line.text)) {
      subsection = undefined;
      continue;
    }

    if (line.text.length > 0 && /[\t ]$/u.test(line.text)) {
      if (subsection || looksLikeAcceptanceBullet(line.text)) {
        malformed("acceptance declaration has trailing whitespace");
      }
    }

    if (subsection === "clauses") {
      const match = line.text.match(CLAUSE_LINE);
      if (match) {
        if (!requirementId) malformed("acceptance clause has no enclosing requirement");
        const [, id, text] = match as RegExpMatchArray & { 1: string; 2: string };
        assertClauseOwner(id, requirementId);
        if (clauseIds.has(id)) malformed(`duplicate acceptance clause id ${id}`);
        clauseIds.add(id);
        const byteStart = line.byteStart + Buffer.byteLength(`- [${id}] `, "utf8");
        clauses.push({
          id,
          requirementId,
          text,
          span: exactSpan(input.sourcePath, input.sourceBytes, byteStart, line.contentEnd),
        });
        continue;
      }
      if (line.text.length > 0) malformed("malformed or continued acceptance clause line");
    } else if (subsection === "dispositions") {
      const match = line.text.match(DISPOSITION_LINE);
      if (match) {
        if (!requirementId) malformed("acceptance disposition has no enclosing requirement");
        const [, clauseId, kind, reason] = match as RegExpMatchArray & {
          1: string;
          2: ParsedCccPrdAcceptanceDisposition["kind"];
          3: string;
        };
        assertClauseOwner(clauseId, requirementId);
        if (dispositionIds.has(clauseId)) malformed(`duplicate disposition for ${clauseId}`);
        dispositionIds.add(clauseId);
        const prefix = `- [${clauseId}] ${kind}: `;
        const byteStart = line.byteStart + Buffer.byteLength(prefix, "utf8");
        dispositions.push({
          clauseId,
          requirementId,
          kind,
          reason,
          span: exactSpan(input.sourcePath, input.sourceBytes, byteStart, line.contentEnd),
        });
        continue;
      }
      if (line.text.length > 0) malformed("malformed or continued acceptance disposition line");
    } else if (looksLikeAcceptanceBullet(line.text)) {
      malformed("acceptance clause bullet is outside an exact acceptance subsection");
    }

  }

  const clausesById = new Map(clauses.map((clause) => [clause.id, clause]));
  for (const disposition of dispositions) {
    const clause = clausesById.get(disposition.clauseId);
    if (!clause || clause.requirementId !== disposition.requirementId) {
      malformed(`acceptance disposition references unknown clause ${disposition.clauseId}`);
    }
  }

  return { clauses, dispositions, requirementIds: [...requirementIds] };
}

export function parseCccPrdAcceptanceClauseInventory(input: {
  sourcePath: string;
  sourceBytes: Buffer;
}): CccPrdAcceptanceClauseInventory {
  const { requirementIds: _, ...inventory } = parseInventory(input);
  return inventory;
}

function manifestInvalid(message: string): never {
  throw new CccPrdCustodyError("CCC_PRD_ACCEPTANCE_CLAUSE_MANIFEST_INVALID", message);
}

function undispositioned(message: string): never {
  throw new CccPrdCustodyError("CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED", message);
}

function exactSingleReference(
  references: unknown,
  path: string,
  exactQuote: string,
): boolean {
  return Array.isArray(references)
    && references.length === 1
    && references[0]?.path === path
    && references[0]?.exactQuote === exactQuote;
}

function sortedUniqueCanonicalIds(values: unknown, label: string): string[] {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => typeof value !== "string" || !CANONICAL_ID.test(value))
    || new Set(values).size !== values.length
  ) {
    undispositioned(`${label} needs at least one unique canonical proof id`);
  }
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function indexUnique<T extends Record<string, unknown>>(
  rows: unknown,
  key: keyof T,
  label: string,
): Map<string, T> {
  if (!Array.isArray(rows)) manifestInvalid(`${label} must be an array`);
  const indexed = new Map<string, T>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) manifestInvalid(`${label} row is malformed`);
    const id = (row as T)[key];
    if (typeof id !== "string" || !CANONICAL_ID.test(id)) manifestInvalid(`${label} has a non-canonical id`);
    if (indexed.has(id)) manifestInvalid(`${label} contains duplicate id ${id}`);
    indexed.set(id, row as T);
  }
  return indexed;
}

export function reconcileCccPrdAcceptanceClauseManifest(input: {
  sourceBytes: ReadonlyMap<string, Buffer>;
  requirements: Array<{
    id: string;
    acceptanceClauses: CccPrdProposalAcceptanceClauseLink[];
    acceptanceDispositions: CccPrdProposalAcceptanceDispositionLink[];
  }>;
}): { requirements: ReconciledCccPrdAcceptanceRequirement[] } {
  const parsed = [...input.sourceBytes.entries()].map(([sourcePath, sourceBytes]) => ({
    sourcePath,
    inventory: parseInventory({ sourcePath, sourceBytes }),
  }));
  const sourceRequirements = new Map<string, string>();
  const sourceClauses = new Map<string, ParsedCccPrdAcceptanceClause>();
  const sourceDispositions = new Map<string, ParsedCccPrdAcceptanceDisposition>();

  for (const source of parsed) {
    for (const requirementId of source.inventory.requirementIds) {
      const prior = sourceRequirements.get(requirementId);
      if (prior !== undefined) malformed(
        `duplicate requirement heading ${requirementId} across ${prior} and ${source.sourcePath}`,
      );
      sourceRequirements.set(requirementId, source.sourcePath);
    }
    for (const clause of source.inventory.clauses) {
      if (sourceClauses.has(clause.id)) malformed(`duplicate acceptance clause id ${clause.id} across sources`);
      sourceClauses.set(clause.id, clause);
    }
    for (const disposition of source.inventory.dispositions) {
      if (sourceDispositions.has(disposition.clauseId)) {
        malformed(`duplicate acceptance disposition for ${disposition.clauseId} across sources`);
      }
      sourceDispositions.set(disposition.clauseId, disposition);
    }
  }

  if (sourceRequirements.size === 0 || sourceClauses.size === 0) {
    undispositioned("v2 semantic normalization requires at least one exact source-declared acceptance clause");
  }

  const proposalRequirements = indexUnique<Record<string, unknown>>(
    input.requirements,
    "id",
    "acceptance requirements",
  );
  for (const requirementId of proposalRequirements.keys()) {
    if (!sourceRequirements.has(requirementId)) {
      manifestInvalid(`proposal requirement ${requirementId} has no exact source requirement heading`);
    }
  }
  for (const requirementId of sourceRequirements.keys()) {
    if (!proposalRequirements.has(requirementId)) {
      undispositioned(`source requirement ${requirementId} is absent from the clause manifest`);
    }
    if (![...sourceClauses.values()].some((clause) => clause.requirementId === requirementId)) {
      undispositioned(`source requirement ${requirementId} declares no exact acceptance clauses`);
    }
  }

  const result: ReconciledCccPrdAcceptanceRequirement[] = [];
  for (const requirementId of [...sourceRequirements.keys()].sort()) {
    const proposal = proposalRequirements.get(requirementId)!;
    const accepted = indexUnique<CccPrdProposalAcceptanceClauseLink & Record<string, unknown>>(
      proposal.acceptanceClauses,
      "id",
      `requirement ${requirementId} acceptance clauses`,
    );
    const dispositioned = indexUnique<CccPrdProposalAcceptanceDispositionLink & Record<string, unknown>>(
      proposal.acceptanceDispositions,
      "clauseId",
      `requirement ${requirementId} acceptance dispositions`,
    );
    for (const id of accepted.keys()) {
      if (dispositioned.has(id)) manifestInvalid(`clause ${id} is both accepted and dispositioned`);
      const source = sourceClauses.get(id);
      if (!source || source.requirementId !== requirementId) {
        manifestInvalid(`accepted clause ${id} is foreign to requirement ${requirementId}`);
      }
      if (sourceDispositions.has(id)) {
        manifestInvalid(`source-dispositioned clause ${id} cannot also be accepted`);
      }
    }
    for (const id of dispositioned.keys()) {
      const source = sourceDispositions.get(id);
      if (!source || source.requirementId !== requirementId) {
        manifestInvalid(`disposition ${id} is foreign to requirement ${requirementId}`);
      }
    }

    const acceptanceClauses: ReconciledCccPrdAcceptanceRequirement["acceptanceClauses"] = [];
    const acceptanceDispositions: ReconciledCccPrdAcceptanceRequirement["acceptanceDispositions"] = [];
    for (const source of [...sourceClauses.values()]
      .filter((clause) => clause.requirementId === requirementId)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
      const declaredDisposition = sourceDispositions.get(source.id);
      if (declaredDisposition) {
        if (declaredDisposition.kind === "unresolved") {
          undispositioned(`acceptance clause ${source.id} remains unresolved`);
        }
        const proposalDisposition = dispositioned.get(source.id);
        if (!proposalDisposition) undispositioned(`acceptance clause ${source.id} is missing its source disposition`);
        if (
          proposalDisposition.requirementId !== requirementId
          || proposalDisposition.kind !== declaredDisposition.kind
          || proposalDisposition.reason !== declaredDisposition.reason
          || !exactSingleReference(
            proposalDisposition.sourceRefs,
            declaredDisposition.span.path,
            declaredDisposition.reason,
          )
        ) {
          manifestInvalid(`acceptance disposition ${source.id} drifted from exact source bytes`);
        }
        acceptanceDispositions.push({
          clauseId: source.id,
          requirementId,
          kind: declaredDisposition.kind,
          reason: declaredDisposition.reason,
          span: declaredDisposition.span,
        });
        continue;
      }

      const proposalClause = accepted.get(source.id);
      if (!proposalClause) undispositioned(`accepted clause ${source.id} is absent from the clause manifest`);
      if (
        proposalClause.requirementId !== requirementId
        || proposalClause.text !== source.text
        || !exactSingleReference(proposalClause.sourceRefs, source.span.path, source.text)
      ) {
        manifestInvalid(`accepted clause ${source.id} drifted from exact source bytes`);
      }
      acceptanceClauses.push({
        id: source.id,
        requirementId,
        text: source.text,
        proofIds: sortedUniqueCanonicalIds(proposalClause.proofIds, `accepted clause ${source.id}`),
        span: source.span,
      });
    }
    result.push({ requirementId, acceptanceClauses, acceptanceDispositions });
  }

  return { requirements: result };
}

export function stampCccPrdAcceptanceClauseLinks(input: {
  sourcePath: string;
  sourceBytes: Buffer;
  requirements: Array<{
    id: string;
    acceptanceClauses: CccPrdProposalAcceptanceClauseLink[];
    acceptanceDispositions: CccPrdProposalAcceptanceDispositionLink[];
  }>;
}): { requirements: ReconciledCccPrdAcceptanceRequirement[] } {
  const source = parseInventory({ sourcePath: input.sourcePath, sourceBytes: input.sourceBytes });
  const sourceRequirements = new Set(source.requirementIds);
  const clauses = new Map(source.clauses.map((clause) => [clause.id, clause]));
  const dispositions = new Map(source.dispositions.map((disposition) => [disposition.clauseId, disposition]));
  const requirements = indexUnique<Record<string, unknown>>(
    input.requirements,
    "id",
    "partial acceptance requirements",
  );
  const result: ReconciledCccPrdAcceptanceRequirement[] = [];

  for (const requirementId of [...requirements.keys()].sort()) {
    if (!sourceRequirements.has(requirementId)) {
      manifestInvalid(`partial requirement ${requirementId} has no exact source requirement heading`);
    }
    const proposal = requirements.get(requirementId)!;
    const accepted = indexUnique<CccPrdProposalAcceptanceClauseLink & Record<string, unknown>>(
      proposal.acceptanceClauses,
      "id",
      `partial requirement ${requirementId} acceptance clauses`,
    );
    const dispositioned = indexUnique<CccPrdProposalAcceptanceDispositionLink & Record<string, unknown>>(
      proposal.acceptanceDispositions,
      "clauseId",
      `partial requirement ${requirementId} acceptance dispositions`,
    );
    const acceptanceClauses: ReconciledCccPrdAcceptanceRequirement["acceptanceClauses"] = [];
    const acceptanceDispositions: ReconciledCccPrdAcceptanceRequirement["acceptanceDispositions"] = [];

    for (const id of accepted.keys()) {
      if (dispositioned.has(id)) manifestInvalid(`clause ${id} is both accepted and dispositioned`);
      const proposalClause = accepted.get(id)!;
      const declared = clauses.get(id);
      if (
        !declared
        || declared.requirementId !== requirementId
        || dispositions.has(id)
        || proposalClause.requirementId !== requirementId
        || proposalClause.text !== declared.text
        || !exactSingleReference(proposalClause.sourceRefs, input.sourcePath, declared.text)
      ) {
        manifestInvalid(`partial accepted clause ${id} drifted from exact source bytes`);
      }
      acceptanceClauses.push({
        id,
        requirementId,
        text: declared.text,
        proofIds: sortedUniqueCanonicalIds(proposalClause.proofIds, `accepted clause ${id}`),
        span: declared.span,
      });
    }
    for (const id of dispositioned.keys()) {
      const proposalDisposition = dispositioned.get(id)!;
      const declared = dispositions.get(id);
      if (!declared || declared.requirementId !== requirementId) {
        manifestInvalid(`partial disposition ${id} is foreign to requirement ${requirementId}`);
      }
      if (declared.kind === "unresolved") undispositioned(`acceptance clause ${id} remains unresolved`);
      if (
        proposalDisposition.requirementId !== requirementId
        || proposalDisposition.kind !== declared.kind
        || proposalDisposition.reason !== declared.reason
        || !exactSingleReference(proposalDisposition.sourceRefs, input.sourcePath, declared.reason)
      ) {
        manifestInvalid(`partial disposition ${id} drifted from exact source bytes`);
      }
      acceptanceDispositions.push({
        clauseId: id,
        requirementId,
        kind: declared.kind,
        reason: declared.reason,
        span: declared.span,
      });
    }
    result.push({
      requirementId,
      acceptanceClauses: acceptanceClauses.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      acceptanceDispositions: acceptanceDispositions.sort((left, right) => (
        left.clauseId < right.clauseId ? -1 : left.clauseId > right.clauseId ? 1 : 0
      )),
    });
  }
  return { requirements: result };
}

export function reconcileCccPrdAcceptanceProofCoverage(input: {
  requirements: ReconciledCccPrdAcceptanceRequirement[];
  proofs: Array<{ id: string; requirementIds: string[]; clauseIds: string[] }>;
}): void {
  const clauses = new Map(input.requirements.flatMap((requirement) => (
    requirement.acceptanceClauses.map((clause) => [clause.id, clause] as const)
  )));
  const proofs = indexUnique<Record<string, unknown>>(input.proofs, "id", "semantic proofs");
  const proofClauses = new Map<string, Set<string>>();

  for (const raw of proofs.values()) {
    const proof = raw as unknown as (typeof input.proofs)[number];
    if (
      !Array.isArray(proof.requirementIds)
      || proof.requirementIds.some((id) => typeof id !== "string" || !CANONICAL_ID.test(id))
      || new Set(proof.requirementIds).size !== proof.requirementIds.length
      || !Array.isArray(proof.clauseIds)
      || proof.clauseIds.some((id) => typeof id !== "string" || !CANONICAL_ID.test(id))
      || new Set(proof.clauseIds).size !== proof.clauseIds.length
    ) {
      manifestInvalid(`proof ${proof.id} has duplicate or malformed clause/requirement IDs`);
    }
    for (const clauseId of proof.clauseIds) {
      const clause = clauses.get(clauseId);
      if (!clause) manifestInvalid(`proof ${proof.id} references foreign clause ${clauseId}`);
      if (!proof.requirementIds.includes(clause.requirementId)) {
        manifestInvalid(`proof ${proof.id} does not own clause ${clauseId}'s requirement`);
      }
      const set = proofClauses.get(proof.id) ?? new Set<string>();
      set.add(clauseId);
      proofClauses.set(proof.id, set);
    }
  }

  for (const clause of clauses.values()) {
    for (const proofId of clause.proofIds) {
      if (!proofs.has(proofId)) manifestInvalid(`clause ${clause.id} references foreign proof ${proofId}`);
      if (!proofClauses.get(proofId)?.has(clause.id)) {
        undispositioned(`proof ${proofId} does not declare coverage for accepted clause ${clause.id}`);
      }
    }
    const covering = [...proofClauses.entries()].filter(([, ids]) => ids.has(clause.id));
    if (covering.length === 0) undispositioned(`accepted clause ${clause.id} has no proof coverage`);
    for (const [proofId] of covering) {
      if (!clause.proofIds.includes(proofId)) {
        manifestInvalid(`proof ${proofId} claims clause ${clause.id} without reciprocal clause linkage`);
      }
    }
  }
}

export function assertCccPrdAcceptanceClauseCustody(input: {
  sourceBytes: ReadonlyMap<string, Buffer>;
  requirements: ReconciledCccPrdAcceptanceRequirement[];
  proofs: Array<{ id: string; requirementIds: string[]; clauseIds: string[] }>;
}): void {
  const proposal = input.requirements.map((requirement) => ({
    id: requirement.requirementId,
    acceptanceClauses: requirement.acceptanceClauses.map((clause) => ({
      id: clause.id,
      requirementId: clause.requirementId,
      text: clause.text,
      proofIds: clause.proofIds,
      sourceRefs: [{ path: clause.span.path, exactQuote: clause.text }],
    })),
    acceptanceDispositions: requirement.acceptanceDispositions.map((disposition) => ({
      clauseId: disposition.clauseId,
      requirementId: disposition.requirementId,
      kind: disposition.kind,
      reason: disposition.reason,
      sourceRefs: [{ path: disposition.span.path, exactQuote: disposition.reason }],
    })),
  }));
  const canonical = reconcileCccPrdAcceptanceClauseManifest({
    sourceBytes: input.sourceBytes,
    requirements: proposal,
  }).requirements;
  if (canonicalCccPrdJson(canonical) !== canonicalCccPrdJson(input.requirements)) {
    manifestInvalid("persisted acceptance-clause text, spans, links, or canonical order drifted from source");
  }
  reconcileCccPrdAcceptanceProofCoverage({ requirements: canonical, proofs: input.proofs });
}
