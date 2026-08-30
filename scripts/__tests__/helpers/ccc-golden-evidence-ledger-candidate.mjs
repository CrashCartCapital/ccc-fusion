import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeContractCandidate(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/record.mjs"), `const required = ["id", "subject", "claim", "observedAt", "source", "confidence"];
const allowed = new Set([...required, "tags"]);
const confidences = new Set(["low", "medium", "high"]);
const utcTimestamp = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/;
function isCalendarTimestamp(value) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59;
}
export function parseEvidenceLine(line, lineNumber) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error("line " + lineNumber + ": invalid json"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("line " + lineNumber + ": record required");
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("line " + lineNumber + ": unknown field " + key);
  for (const key of required) if (typeof value[key] !== "string" || value[key].length === 0) throw new Error("line " + lineNumber + ": missing " + key);
  if (!utcTimestamp.test(value.observedAt) || !isCalendarTimestamp(value.observedAt)) throw new Error("line " + lineNumber + ": invalid timestamp");
  if (!confidences.has(value.confidence)) throw new Error("line " + lineNumber + ": invalid confidence");
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag.length === 0) || new Set(value.tags).size !== value.tags.length)) throw new Error("line " + lineNumber + ": invalid tags");
  return { id: value.id, subject: value.subject, claim: value.claim, observedAt: value.observedAt, source: value.source, confidence: value.confidence, ...(value.tags === undefined ? {} : { tags: [...value.tags].sort() }) };
}
`);
  await writeFile(path.join(root, "src/validation.mjs"), `export function validateEvidenceRecords(records) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.id)) throw new Error("duplicate id: " + record.id);
    seen.add(record.id);
  }
  return records;
}
`);
}

export async function writeCoreCandidate(root) {
  await writeContractCandidate(root);
  await writeFile(path.join(root, "src/ledger.mjs"), `export function buildLedger(records) {
  const canonicalRecords = records.map((record) => ({ ...record, ...(record.tags ? { tags: [...record.tags].sort() } : {}) }))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  const grouped = new Map();
  for (const record of canonicalRecords) {
    const ids = grouped.get(record.subject) ?? [];
    ids.push(record.id);
    grouped.set(record.subject, ids);
  }
  return {
    schema: "evidence-ledger.report.v1",
    recordCount: canonicalRecords.length,
    subjects: [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([subject, recordIds]) => ({ subject, count: recordIds.length, recordIds })),
    records: canonicalRecords,
  };
}
`);
  await writeFile(path.join(root, "src/report.mjs"), `export function renderJsonReport(ledger) {
  return JSON.stringify(ledger, null, 2) + "\\n";
}
export function renderTextReport(ledger) {
  const byId = new Map(ledger.records.map((record) => [record.id, record]));
  const output = ["Evidence Ledger Report", "Records: " + ledger.recordCount];
  for (const subject of ledger.subjects) {
    output.push("Subject: " + subject.subject + " (" + subject.count + ")");
    for (const recordId of subject.recordIds) {
      const record = byId.get(recordId);
      output.push("- " + record.observedAt + " [" + record.confidence + "] " + record.id + " | " + record.claim + " | source=" + record.source + " | tags=" + (record.tags?.join(",") ?? "none"));
    }
  }
  return output.join("\\n") + "\\n";
}
`);
}

export async function writeCliCandidate(root) {
  await writeCoreCandidate(root);
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(path.join(root, "bin/evidence-ledger.mjs"), `import { readFileSync } from "node:fs";
import { parseEvidenceLine } from "../src/record.mjs";
import { validateEvidenceRecords } from "../src/validation.mjs";
import { buildLedger } from "../src/ledger.mjs";
import { renderJsonReport, renderTextReport } from "../src/report.mjs";
const usage = "Usage: node bin/evidence-ledger.mjs report <input> --format json|text\\n--format json\\n--format text\\n";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(usage);
} else if (args.length !== 4 || args[0] !== "report" || args[2] !== "--format" || !["json", "text"].includes(args[3])) {
  process.stderr.write(usage);
  process.exitCode = 1;
} else {
  let source;
  try { source = readFileSync(args[1], "utf8"); } catch (error) {
    process.stderr.write("input error: " + error.code + "\\n");
    process.exitCode = 1;
  }
  if (source !== undefined) {
    try {
      const records = source.trimEnd().split("\\n").map((line, index) => parseEvidenceLine(line, index + 1));
      const ledger = buildLedger(validateEvidenceRecords(records));
      process.stdout.write(args[3] === "json" ? renderJsonReport(ledger) : renderTextReport(ledger));
    } catch (error) {
      process.stderr.write(error.message + "\\n");
      process.exitCode = 2;
    }
  }
}
`);
  await writeFile(path.join(root, "README.md"), [
    "# Evidence Ledger",
    "",
    "node bin/evidence-ledger.mjs report fixtures/valid.ndjson --format json",
    "node bin/evidence-ledger.mjs report fixtures/valid.ndjson --format text",
    "",
  ].join("\n"));
}
