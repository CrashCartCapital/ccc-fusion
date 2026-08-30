#!/usr/bin/env node

import { runEvidenceLedgerCommand } from "./lib/ccc-golden-evidence-ledger.mjs";

process.exitCode = await runEvidenceLedgerCommand(process.argv.slice(2));
