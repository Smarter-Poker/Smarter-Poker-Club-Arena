/**
 * A busted tournament seat and its standings zero are one hand transaction.
 *
 * The old runtime vacated table_seats, then separately zeroed
 * tournament_players, while a later elimination sweep tried to repair either
 * half. A crash or race between those writers stranded a player or overwrote
 * a newer stack. The hand-stack authority now owns all three results: settled
 * seat stacks, the standings mirror, and zero-stack seat release.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBlockAfter, sliceSqlStatement } from '../testHelpers/sourceWindow.js';

const dealing = readFileSync(join(__dirname, '../engine/ServerTableEngineDealing.ts'), 'utf8');
const migrations = join(__dirname, '../../../supabase/migrations');
const terminalMigration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260908065324_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Select only literal full definitions, never ACL/signature/hardener mentions. */
function newestFullDefinition(fn: string): string {
  const create = new RegExp(
    `^[\\t ]*CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${escapeRegExp(fn)}\\s*\\(`,
    'gim'
  );
  const definitions: string[] = [];

  for (const filename of readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const migration = readFileSync(join(migrations, filename), 'utf8');
    for (const match of migration.matchAll(create)) {
      const start = match.index;
      const tail = migration.slice(start);
      const opener = /\bAS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i.exec(tail);
      if (!opener) throw new Error(`${filename}: ${fn} has no dollar-quoted function body`);

      const delimiter = opener[1];
      const bodyStart = start + opener.index + opener[0].length;
      const bodyEnd = migration.indexOf(delimiter, bodyStart);
      if (bodyEnd === -1) throw new Error(`${filename}: ${fn} has no closing ${delimiter}`);

      definitions.push(migration.slice(start, bodyEnd + delimiter.length));
    }
  }

  if (definitions.length === 0) throw new Error(`No full definition found for public.${fn}`);
  return definitions[definitions.length - 1];
}

function delimitedBlock(source: string, delimiter: string): string {
  const start = source.indexOf(delimiter);
  const end = source.indexOf(delimiter, start + delimiter.length);
  if (start === -1 || end === -1) throw new Error(`Missing ${delimiter} block`);
  return source.slice(start + delimiter.length, end);
}

function dollarAssignment(source: string, variable: string): string {
  const assignment = new RegExp(
    `\\b${escapeRegExp(variable)}\\s+(?:constant\\s+)?text\\s*:=\\s*(\\$[A-Za-z_][A-Za-z0-9_]*\\$|\\$\\$)`,
    'i'
  ).exec(source);
  if (!assignment) throw new Error(`Missing ${variable} dollar-quoted assignment`);

  const delimiter = assignment[1];
  const start = assignment.index + assignment[0].length;
  const end = source.indexOf(delimiter, start);
  if (end === -1) throw new Error(`Missing ${variable} closing ${delimiter}`);
  return source.slice(start, end);
}

function handStackBodyAfterTerminalHardening(): { body: string; hardener: string } {
  const hardener = delimitedBlock(terminalMigration, '$harden_hand_stack_lock_order$');
  const needle = dollarAssignment(hardener, 'v_sync_needle');
  const replacement = dollarAssignment(hardener, 'v_sync_replacement');
  const authoritative = newestFullDefinition('fn_ca_settle_hand_stacks_absolute');
  const occurrences = authoritative.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Hand-stack hardener needle occurs ${occurrences} times in its full definition`
    );
  }
  return { body: authoritative.replace(needle, replacement), hardener };
}

describe('busted tournament seats close at the stack authority', () => {
  it('has no process-side standings or seat writer after a bust', () => {
    const block = sliceBlockAfter(dealing, 'for (const player of justBustedPlayers)');
    expect(block).toContain("reason: 'busted_awaiting_rebuy_decision'");
    expect(block).not.toContain(".from('table_seats')");
    expect(block).not.toContain(".from('tournament_players')");
    expect(block).not.toContain('.update({ chips: 0 })');
  });

  it('mirrors standings before atomically releasing named zero-stack seats', () => {
    const { body, hardener } = handStackBodyAfterTerminalHardening();
    const mirror = body.indexOf('UPDATE public.tournament_players');
    const vacate = body.indexOf('UPDATE public.table_seats', mirror + 1);
    expect(mirror).toBeGreaterThan(-1);
    expect(vacate).toBeGreaterThan(mirror);
    const vacateStatement = sliceSqlStatement(body.slice(mirror), 'UPDATE public.table_seats');
    expect(vacateStatement).toMatch(/left_at[\s\S]*stack\s*=\s*0/);
    expect(hardener).toMatch(
      /v_hardened\s*:=\s*replace\(v_hardened,v_sync_needle,v_sync_replacement\)/
    );
    expect(hardener).toMatch(/EXECUTE\s+v_hardened/);
  });
});
