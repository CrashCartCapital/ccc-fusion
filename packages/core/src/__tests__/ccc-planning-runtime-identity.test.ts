import { beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:CccPlanningRuntimeIdentity 2026-10-14-08:40:
Card K1 proof for the running-runtime registry (D44). The engine that runs planning work registers its installed dist manifest digest once; H1, RV and BF then refuse any run whose stored digest differs, and refuse everything while nothing is registered. The registry is process state, so every test loads a fresh module instance instead of relying on a test-only reset export.
*/

type RuntimeIdentityModule = typeof import("../ccc-planning/runtime-identity.js");
type ErrorsModule = typeof import("../ccc-planning/errors.js");

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

let identity: RuntimeIdentityModule;
let errors: ErrorsModule;

beforeEach(async () => {
  vi.resetModules();
  identity = await import("../ccc-planning/runtime-identity.js");
  errors = await import("../ccc-planning/errors.js");
});

function refusalCode(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(errors.CccPlanningRefusal);
    return (error as InstanceType<ErrorsModule["CccPlanningRefusal"]>).code;
  }
}

describe("running runtime identity", () => {
  it("refuses every run while no runtime is registered", () => {
    expect(identity.readCccRunningRuntimeDistManifest()).toBeNull();
    expect(refusalCode(() => identity.assertCccRunningRuntimePermitted({ runtimeDistManifestSha256: DIGEST_A })))
      .toBe("CCC_PLANNING_RUNTIME_NOT_PERMITTED");
  });

  it("permits the registered digest and refuses a different one", () => {
    identity.registerCccRunningRuntimeDistManifest(DIGEST_A);
    expect(identity.readCccRunningRuntimeDistManifest()).toBe(DIGEST_A);
    expect(refusalCode(() => identity.assertCccRunningRuntimePermitted({ runtimeDistManifestSha256: DIGEST_A }))).toBeNull();
    expect(refusalCode(() => identity.assertCccRunningRuntimePermitted({ runtimeDistManifestSha256: DIGEST_B })))
      .toBe("CCC_PLANNING_RUNTIME_NOT_PERMITTED");
  });

  it("accepts the same digest twice and throws on a different second value", () => {
    identity.registerCccRunningRuntimeDistManifest(DIGEST_A);
    expect(() => identity.registerCccRunningRuntimeDistManifest(DIGEST_A)).not.toThrow();
    expect(() => identity.registerCccRunningRuntimeDistManifest(DIGEST_B)).toThrow(/already registered/);
    expect(identity.readCccRunningRuntimeDistManifest()).toBe(DIGEST_A);
  });

  it("refuses to register a value that is not a lowercase sha256", () => {
    expect(() => identity.registerCccRunningRuntimeDistManifest("A".repeat(64))).toThrow(TypeError);
    expect(() => identity.registerCccRunningRuntimeDistManifest("a".repeat(63))).toThrow(TypeError);
    expect(identity.readCccRunningRuntimeDistManifest()).toBeNull();
  });
});
