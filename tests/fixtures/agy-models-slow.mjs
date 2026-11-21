#!/usr/bin/env node
// Read-only CLI catalog fixture that answers after AGY_FIXTURE_DELAY_MS and
// records each run in AGY_FIXTURE_TRACE. Never launches an engine or reads user state.
import { appendFileSync } from "node:fs";
if (process.argv[2] !== "models") process.exit(2);
if (process.env.AGY_FIXTURE_TRACE) appendFileSync(process.env.AGY_FIXTURE_TRACE, "models\n");
setTimeout(() => {
  process.stdout.write("gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
}, Number(process.env.AGY_FIXTURE_DELAY_MS ?? 0));
