#!/usr/bin/env node
/**
 * Command line for tests/helpers/operational-sender-addressing.mjs: every SQL
 * function that records a Production Alerts event must prove, on every call,
 * that payload.target_task_id is the fleet id.
 *
 * The rule lives under tests/ on purpose. scripts/ci/classify-ci-changes.mjs
 * sends a pull request that touches tests/ to the required Client Unit Tests
 * (vitest) check, and one that touches only scripts/ci/ to nothing required,
 * so a checker kept here could be weakened and merge on green. The blocking
 * readings are tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts
 * (the whole corpus) and ...decisions.test.ts (the rule's own cases). This file
 * only parses arguments for the advisory job in
 * .github/workflows/operational-alert-addressing.yml, the one reading that knows
 * which migrations a branch adds (--added-since <rev>).
 *
 * Run:  node scripts/ci/check-operational-sender-addressing.mjs [--dir <migrations>] [--added-since <rev>]
 * Exit: 0 addressed; 1 UNADDRESSED; 3 COULD NOT TELL.
 */
import { pathToFileURL } from 'node:url';
import { run, UNKNOWN } from '../../tests/helpers/operational-sender-addressing.mjs';

export * from '../../tests/helpers/operational-sender-addressing.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    result = run(process.argv.slice(2));
  } catch (error) {
    result = { code: UNKNOWN, lines: [`COULD NOT TELL  ${error.message}`] };
  }
  for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
  process.exitCode = result.code;
}
