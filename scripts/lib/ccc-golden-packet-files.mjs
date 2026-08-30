import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

function assertSafeRelativePath(value, field, { nested = true } = {}) {
  const segments = typeof value === "string" ? value.split(/[\\/]/) : [];
  if (
    segments.length === 0
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || (!nested && segments.length !== 1)
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes("\0")
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function resolveContained(root, field, ...segments) {
  const candidate = path.resolve(root, ...segments);
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`${field} must be a safe relative path`);
  }
  return candidate;
}

export async function writeEvidenceLedgerPacketSources(root, definition) {
  assertSafeRelativePath(definition.projectName, "projectName", { nested: false });
  assertSafeRelativePath(definition.prdFileName, "prdFileName", { nested: false });
  assertSafeRelativePath(definition.supportRelativePath, "supportRelativePath");

  try {
    if ((await readdir(root)).length > 0) throw new Error("packet source target is not empty");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const target = path.resolve(root);
  const staging = await mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}-staging-`));
  try {
    const projectRoot = resolveContained(staging, "projectName", definition.projectName);
    const prdPath = resolveContained(projectRoot, "prdFileName", definition.prdFileName);
    const supportPath = resolveContained(
      projectRoot,
      "supportRelativePath",
      definition.supportRelativePath,
    );
    await mkdir(path.dirname(supportPath), { recursive: true });
    await writeFile(prdPath, definition.prd, { flag: "wx" });
    await writeFile(supportPath, definition.support, { flag: "wx" });
    await rename(staging, target);
    return {
      prdPath: path.join(target, definition.projectName, definition.prdFileName),
      supportPath: path.join(target, definition.projectName, definition.supportRelativePath),
      fileCount: 2,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
