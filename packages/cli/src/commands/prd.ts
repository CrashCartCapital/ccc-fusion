import * as engine from "@fusion/engine";

export type PrdCommandIo = { write(line: string): void };
type Compiler = { compileCccPrdPacket(input: { rootDir: string; manifestPath: string }): { kind: "bundle" | "refusal" } };
const compiler = engine as typeof engine & Compiler;

export function runPrdCommand(args: string[], io: PrdCommandIo = { write: (line) => console.log(line) }): number {
  const [subcommand, rootDir, manifestPath] = args;
  if ((subcommand !== "compile" && subcommand !== "validate") || !rootDir || !manifestPath) { io.write("usage: fusion prd <compile|validate> <root-dir> <manifest-path>"); return 2; }
  const result = compiler.compileCccPrdPacket({ rootDir, manifestPath }); io.write(JSON.stringify(result)); return result.kind === "bundle" ? 0 : 1;
}
