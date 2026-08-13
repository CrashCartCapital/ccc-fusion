/* global process, URL */

function executableBasename(value) {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

const moduleBasename = executableBasename(decodeURIComponent(new URL(import.meta.url).pathname));
if (
  process.argv[1]
  && process.argv[2] === "--version"
  && executableBasename(process.argv[1]) === moduleBasename
) {
  process.stdout.write("fusion-cli-semantic-proof-host.v1\n");
}

export * from "../engine/src/ccc-campaign-proof-admission.js";
