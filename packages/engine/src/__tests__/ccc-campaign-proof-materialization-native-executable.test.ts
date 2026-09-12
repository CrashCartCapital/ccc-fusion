// RED-S5-native-executable-classifier: the sealed proof host is probed
// directly (`<host> --version`) only when its bytes open a native platform
// executable; otherwise it is assumed to be a JavaScript file and launched
// through sealed Node (`node <host> --version`). On Linux CI the sealed proof
// host is Node's own ELF binary, so this classifier must recognise ELF magic
// on linux the same way it already recognises Mach-O magic on darwin -- see
// packages/engine/src/ccc-campaign-proof-materialization.ts, sealedProofHostIdentity.
import { describe, expect, it } from "vitest";
import { isNativeExecutableBytes } from "../ccc-campaign-proof-materialization.js";

const ELF_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const MACH_O_64_BYTES = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0x0c, 0x00, 0x00, 0x01]);
const JS_SHEBANG_BYTES = Buffer.from("#!/usr/bin/env node\nconsole.log(1);\n", "utf8");

describe("isNativeExecutableBytes", () => {
  it("RED-S5-native-executable-classifier: ELF bytes on linux are native", () => {
    expect(isNativeExecutableBytes(ELF_BYTES, "linux")).toBe(true);
  });

  it("RED-S5-native-executable-classifier: Mach-O bytes on darwin are native", () => {
    expect(isNativeExecutableBytes(MACH_O_64_BYTES, "darwin")).toBe(true);
  });

  it("RED-S5-native-executable-classifier: ELF bytes on darwin are not native (unchanged darwin behavior)", () => {
    expect(isNativeExecutableBytes(ELF_BYTES, "darwin")).toBe(false);
  });

  it("RED-S5-native-executable-classifier: Mach-O bytes on linux are not native", () => {
    expect(isNativeExecutableBytes(MACH_O_64_BYTES, "linux")).toBe(false);
  });

  it("RED-S5-native-executable-classifier: a JS shebang file is not native on darwin or linux", () => {
    expect(isNativeExecutableBytes(JS_SHEBANG_BYTES, "darwin")).toBe(false);
    expect(isNativeExecutableBytes(JS_SHEBANG_BYTES, "linux")).toBe(false);
  });

  it("RED-S5-native-executable-classifier: fewer than 4 bytes is never native", () => {
    expect(isNativeExecutableBytes(Buffer.from([0x7f, 0x45]), "linux")).toBe(false);
    expect(isNativeExecutableBytes(Buffer.alloc(0), "darwin")).toBe(false);
  });

  it("RED-S5-native-executable-classifier: an unhandled platform is never native", () => {
    expect(isNativeExecutableBytes(ELF_BYTES, "win32")).toBe(false);
    expect(isNativeExecutableBytes(MACH_O_64_BYTES, "win32")).toBe(false);
  });
});
