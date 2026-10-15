import {
  CCC_PLANNING_STAGE_KINDS,
  validateCccPlanningDecisionRecordV1,
  validateCccPlanningObjectionV1,
  type CccPlanningArtifactRef,
  type CccPlanningDecisionRecordV1,
  type CccPlanningObjectionV1,
  type CccPlanningRoleId,
  type CccPlanningStageId,
  type CccPrdDiagnostic,
  type CccReviewVerdict,
} from "@fusion/core";

/*
FNXC:CccPlanningObjections 2026-10-14-18:50:
Card GG, G3 and D47 (challenge 14). The controller, not the reviewer, writes objections: every finding of a reviewer's verdict becomes one `objection` content in the reviewer's own stage, carrying the finding's ref and severity unchanged, and the stage must be one that may publish objections (section 2.4). A finding's optional `path` and `line` have no slot in the frozen objection schema, so they are appended to the summary rather than dropped. Findings are converted whatever the verdict, because D47 converts every finding; an accept verdict's advisory findings become advisory objections.
FNXC:CccPlanningObjections 2026-10-14-18:50:
G3 refuses spec-ready while a blocking objection lacks a resolving decision record. A record resolves a blocking objection when it names that objection's artifact key and its disposition is `accepted` (the fix is in the reviewed closure) or `rejected` with at least one evidence ref; `deferred` resolves advisory objections only, and advisory objections need no record. A record that fails its schema resolves nothing. When several records name one objection (the spec author's, then a repairing author's), any resolving record resolves it: records carry no order of their own, and a later fix must be able to close an objection an earlier record deferred.
*/

export type CccPlanningObjectionContext = Readonly<{
  stageId: CccPlanningStageId;
  reviewerRoleId: CccPlanningRoleId;
  reviewedRef: CccPlanningArtifactRef;
}>;

/** An objection content with the artifact key it was published under; decision records name that key. */
export type CccPlanningKeyedObjection = Readonly<{ artifactKey: string; objection: CccPlanningObjectionV1 }>;

const SUMMARY_MAX_LOCATION = 200;

function summaryOf(finding: CccReviewVerdict["findings"][number]): string {
  if (finding.path === undefined && finding.line === undefined) return finding.summary;
  const location = `${finding.path ?? "?"}${finding.line === undefined ? "" : `:${finding.line}`}`;
  return `${finding.summary} (at ${location.slice(0, SUMMARY_MAX_LOCATION)})`;
}

/** One objection per finding, in finding order; throws TypeError when the stage may not publish objections or a result is invalid. */
export function cccPlanningObjectionsFromVerdict(
  verdict: CccReviewVerdict,
  context: CccPlanningObjectionContext,
): CccPlanningObjectionV1[] {
  const kinds = CCC_PLANNING_STAGE_KINDS[context.stageId] as readonly string[] | undefined;
  if (!kinds?.includes("objection")) {
    throw new TypeError(`stage ${context.stageId} may not publish an objection artifact`);
  }
  return verdict.findings.map((finding, index) => {
    const objection: CccPlanningObjectionV1 = {
      stageId: context.stageId,
      reviewerRoleId: context.reviewerRoleId,
      severity: finding.severity,
      ref: finding.ref,
      summary: summaryOf(finding),
      reviewedRef: context.reviewedRef,
    };
    const problems = validateCccPlanningObjectionV1(objection);
    if (problems.length > 0) throw new TypeError(`finding ${index} is not a valid objection: ${problems.join("; ")}`);
    return objection;
  });
}

function resolves(record: CccPlanningDecisionRecordV1, severity: CccPlanningObjectionV1["severity"]): boolean {
  if (record.disposition === "accepted") return true;
  if (record.disposition === "rejected") return record.evidence.length > 0;
  return record.disposition === "deferred" && severity === "advisory";
}

/** G3: one CCC_PLANNING_OBJECTION_UNRESOLVED diagnostic per blocking objection without a resolving decision record. */
export function assessCccPlanningObjectionDispositions(
  objections: readonly CccPlanningKeyedObjection[],
  decisionRecords: readonly CccPlanningDecisionRecordV1[],
): CccPrdDiagnostic[] {
  const valid = decisionRecords.filter((record) => validateCccPlanningDecisionRecordV1(record).length === 0);
  const diagnostics: CccPrdDiagnostic[] = [];
  for (const { artifactKey, objection } of objections) {
    if (objection.severity !== "blocking") continue;
    const records = valid.filter((record) => record.objectionKey === artifactKey);
    if (records.some((record) => resolves(record, objection.severity))) continue;
    const why = records.length === 0
      ? "has no decision record"
      : `has only ${records.map((record) => (record.disposition === "rejected" ? "rejected without evidence" : record.disposition)).join(", ")} decision records`;
    diagnostics.push({
      code: "CCC_PLANNING_OBJECTION_UNRESOLVED",
      message: `blocking objection ${artifactKey} from ${objection.reviewerRoleId} in stage ${objection.stageId} ${why}`
        + "; it needs accepted, or rejected with at least one evidence ref",
    });
  }
  return diagnostics;
}
