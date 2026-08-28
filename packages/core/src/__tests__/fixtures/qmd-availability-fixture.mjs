#!/usr/bin/env node
/**
 * Runs the real awaited qmd availability probe in a short-lived process.
 * The probe must keep its own child alive until the promise settles; otherwise
 * Node abandons the top-level await and exits with code 13.
 */
import { isQmdAvailable } from "../../memory-backend.ts";

console.log("qmd-availability-fixture:started");
const mode = process.argv[2] ?? "default";
const keepCallerAlive = mode === "unref-timeout"
  ? setInterval(() => undefined, 1_000)
  : undefined;
const available = mode === "unref-timeout"
  ? await isQmdAvailable({ keepProcessAlive: false })
  : await isQmdAvailable();
if (keepCallerAlive) clearInterval(keepCallerAlive);
console.log(`qmd-availability-fixture:available=${available}`);
