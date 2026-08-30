import { createHash } from "node:crypto";

const SCHEMA = "ccc-golden.experiment-receipt.v1";
const HASH_RE = /^[0-9a-f]{64}$/;

const rootFields = [
  "budget",
  "changedPaths",
  "firstMutation",
  "harness",
  "proof",
  "residue",
  "route",
  "routeProof",
  "schema",
  "targetHashes",
  "terminalOutcome",
  "toolArgs",
];

const shapes = {
  targetHashes: ["repository", "taskPacket", "workspace"],
  harness: [
    "agentHash",
    "argvHash",
    "configHash",
    "id",
    "promptHash",
    "toolSchemaHash",
    "version",
  ],
  budget: ["completionTokens", "elapsedMs", "mutationCount", "promptTokens", "toolCallCount"],
  route: ["configured", "effective", "requested", "selected"],
  routeProof: ["evidenceHash", "state"],
  firstMutation: ["at", "contentHashAfter", "contentHashBefore", "observed", "path"],
  proof: ["commandHash", "evidenceHash", "state"],
  residue: ["dirtyPaths", "notes", "untrackedPaths"],
  toolArg: ["argsHash", "byteLength", "tool", "truncated"],
};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function assertObject(value, pathName) {
  if (!isRecord(value)) fail(`${pathName} is required`);
}

function assertShape(value, allowed, pathName) {
  assertObject(value, pathName);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`unknown field: ${pathName === "receipt" ? key : `${pathName}.${key}`}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail(`${pathName === "receipt" ? key : `${pathName}.${key}`} is required`);
  }
}

function assertHash(value, pathName) {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    fail(`${pathName} must be a sha256 hex hash`);
  }
}

function assertString(value, pathName) {
  if (typeof value !== "string" || value.length === 0) fail(`${pathName} is required`);
}

function assertIsoUtc(value, pathName) {
  assertString(value, pathName);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (!match) {
    fail(`${pathName} must be UTC second precision`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) {
    fail(`${pathName} must be a real UTC timestamp`);
  }
}

function assertCounter(value, pathName) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${pathName} must be a bounded counter`);
}

function assertStringArray(value, pathName) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${pathName} must be an array of strings`);
  }
}

function assertState(value, pathName, allowed) {
  assertString(value, pathName);
  if (!allowed.includes(value)) fail(`${pathName} has invalid state`);
}

function assertNoRawPayloads(value, pathName = "receipt") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawPayloads(entry, `${pathName}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(prompt|secret|password|token|apiKey)$/i.test(key) && !/Hash$/.test(key)) {
      fail(`${pathName}.${key} must be stored as a hash`);
    }
    assertNoRawPayloads(nested, `${pathName}.${key}`);
  }
}

function validateTargetHashes(value) {
  assertShape(value, shapes.targetHashes, "targetHashes");
  for (const key of shapes.targetHashes) assertHash(value[key], `targetHashes.${key}`);
}

function validateHarness(value) {
  assertShape(value, shapes.harness, "harness");
  assertString(value.id, "harness.id");
  assertString(value.version, "harness.version");
  for (const key of shapes.harness.filter((field) => field.endsWith("Hash"))) {
    assertHash(value[key], `harness.${key}`);
  }
}

function validateBudget(value) {
  assertShape(value, shapes.budget, "budget");
  for (const key of shapes.budget) assertCounter(value[key], `budget.${key}`);
}

function validateRoute(value) {
  assertShape(value, shapes.route, "route");
  for (const key of shapes.route) assertString(value[key], `route.${key}`);
}

function validateRouteProof(value) {
  assertShape(value, shapes.routeProof, "routeProof");
  assertState(value.state, "routeProof.state", ["ROUTE_PROVEN", "ROUTE_UNKNOWN"]);
  assertHash(value.evidenceHash, "routeProof.evidenceHash");
}

function validateFirstMutation(value) {
  assertObject(value, "firstMutation");
  if (typeof value.observed !== "boolean") fail("firstMutation.observed is required");
  assertShape(value, value.observed ? shapes.firstMutation : ["observed"], "firstMutation");
  if (value.observed) {
    assertIsoUtc(value.at, "firstMutation.at");
    assertString(value.path, "firstMutation.path");
    assertHash(value.contentHashBefore, "firstMutation.contentHashBefore");
    assertHash(value.contentHashAfter, "firstMutation.contentHashAfter");
  }
}

function validateProof(value) {
  assertShape(value, shapes.proof, "proof");
  assertState(value.state, "proof.state", ["PASS", "FAIL", "PARTIAL", "UNVERIFIED"]);
  assertHash(value.commandHash, "proof.commandHash");
  assertHash(value.evidenceHash, "proof.evidenceHash");
}

function validateResidue(value) {
  assertShape(value, shapes.residue, "residue");
  assertStringArray(value.untrackedPaths, "residue.untrackedPaths");
  assertStringArray(value.dirtyPaths, "residue.dirtyPaths");
  assertStringArray(value.notes, "residue.notes");
  if (value.notes.some((note) => !/^[A-Z0-9_:-]{1,128}$/.test(note))) {
    fail("residue.notes must contain bounded codes");
  }
}

function validateToolArgs(value) {
  if (!Array.isArray(value)) fail("toolArgs is required");
  for (const [index, entry] of value.entries()) {
    const pathName = `toolArgs[${index}]`;
    assertShape(entry, shapes.toolArg, pathName);
    assertString(entry.tool, `${pathName}.tool`);
    assertHash(entry.argsHash, `${pathName}.argsHash`);
    assertCounter(entry.byteLength, `${pathName}.byteLength`);
    if (typeof entry.truncated !== "boolean") fail(`${pathName}.truncated is required`);
  }
}

export function validateExperimentReceipt(receipt) {
  assertShape(receipt, rootFields, "receipt");
  if (receipt.schema !== SCHEMA) fail("schema is invalid");
  assertNoRawPayloads(receipt);
  validateTargetHashes(receipt.targetHashes);
  validateHarness(receipt.harness);
  validateBudget(receipt.budget);
  validateRoute(receipt.route);
  validateRouteProof(receipt.routeProof);
  if (receipt.routeProof.state === "ROUTE_PROVEN" && receipt.route.effective === "ROUTE_UNKNOWN") {
    fail("ROUTE_PROVEN requires a known effective route");
  }
  if (receipt.routeProof.state === "ROUTE_UNKNOWN" && receipt.route.effective !== "ROUTE_UNKNOWN") {
    fail("a known effective route requires ROUTE_PROVEN");
  }
  validateFirstMutation(receipt.firstMutation);
  validateProof(receipt.proof);
  assertState(receipt.terminalOutcome, "terminalOutcome", ["PASS", "FAIL", "PARTIAL", "CANCELLED", "ERROR"]);
  assertStringArray(receipt.changedPaths, "changedPaths");
  validateResidue(receipt.residue);
  validateToolArgs(receipt.toolArgs);
  return receipt;
}

export function canonicalJson(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol"
    || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) {
    fail(`${String(value)} is not canonical JSON`);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeExperimentReceipt(receipt) {
  validateExperimentReceipt(receipt);
  return `${canonicalJson(receipt)}\n`;
}

export function parseExperimentReceipt(source) {
  if (typeof source !== "string") fail("receipt source is required");
  return validateExperimentReceipt(JSON.parse(source));
}

export function hashBoundedToolArgs(tool, args, { maxBytes = 4096 } = {}) {
  assertString(tool, "tool");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("maxBytes must be a positive integer");
  const bytes = Buffer.from(canonicalJson(args));
  const hash = createHash("sha256");
  hash.update("ccc-golden.tool-args.v1");
  hash.update("\0");
  hash.update(tool);
  hash.update("\0");
  hash.update(bytes);
  return {
    argsHash: hash.digest("hex"),
    byteLength: bytes.length,
    truncated: bytes.length > maxBytes,
  };
}
