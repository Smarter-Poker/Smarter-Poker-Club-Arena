import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * AUTO RESTART / AUTO EXTENSION / AUTO CREATE TABLE — three switches on the
 * table creation page with three tooltips and, until 2026-08-25, zero readers.
 *
 * `auto_restart` was worse than merely dead. CreateTableModal's checkbox landed
 * in the `settings` JSONB blob nothing reads, so it never reached the column at
 * all — the same class of bug as the straddle / bomb-pot / ante mirrors beside
 * it in TableService.
 *
 * Each switch now means what its tooltip promises, anchored to behaviour that
 * already existed rather than invented:
 *
 *   AUTO RESTART       GameServer's boot comment is the anchor — "CLOSED IS A
 *                      DECISION, NOT A STATE TO CLEAN UP ... the fleet still
 *                      reopens the tables it OWNS". A host's table, once
 *                      closed, stayed closed forever. This is the host saying
 *                      "reopen mine too".
 *   AUTO EXTENSION     extends the table's LIFE: an empty table carrying it is
 *                      skipped by retireSurplusTables instead of being closed
 *                      for going quiet.
 *   AUTO CREATE TABLE  the overflow spawn the fleet's own tables already got,
 *                      extended to a host's table.
 *
 * The rules live in SQL (fn_table_lifecycle_pass) because spawnOverflowTables
 * only knows DEFAULT_TABLES, matched by name prefix — a host's table is not in
 * that list and never could be. Verified against production in rolled-back
 * transactions; see the migration header.
 */

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('auto extension vetoes retirement, in the query that does the closing', () => {
  const fleet = src('server/src/services/HorseFleetManager.ts');

  it('is applied to the UPDATE, not filtered on the JS side', () => {
    // A check anywhere else could be raced past between the seat fetch and the
    // close. This is the statement that closes the table.
    // The window is generous because the reasoning sits between the two, and
    // that comment is the point: it is why the check is HERE and not in JS.
    expect(fleet).toMatch(/\.update\(\{ status: 'closed' \}\)[\s\S]{0,2400}?auto_extension/);
  });

  it('...but a RETIRED table closes anyway (Dan 2026-09-03, "close any tables over 2/5")', () => {
    /* auto_extension is a host saying "do not close my table just because it
       went quiet". A retirement is the club saying this stake is not offered
       any anymore, and that outranks it - otherwise the table is drained to
       empty by the session rotator, refused a re-seat forever because it is in
       surplusTableIds, and then skipped by this very filter: permanently
       empty, permanently open, invisible to every sweep.

       Still one expression on the UPDATE, for the same race reason as above. */
    expect(fleet).toMatch(
      /\.update\(\{ status: 'closed' \}\)[\s\S]{0,2400}?\.or\(\s*'auto_extension\.is\.null,auto_extension\.eq\.false,settings->>retire_when_empty\.eq\.true'\s*\)/
    );
  });
});

describe('the lifecycle pass runs, and knows more than DEFAULT_TABLES', () => {
  const fleet = src('server/src/services/HorseFleetManager.ts');

  it('is called on every cycle', () => {
    expect(fleet).toContain('await this.runTableLifecyclePass();');
  });

  it('asks the database, which can see every flagged table', () => {
    expect(fleet).toContain("supabase.rpc('fn_table_lifecycle_pass')");
  });

  it('never lets a failed pass take the fleet cycle down with it', () => {
    const body = fleet.slice(
      fleet.indexOf('private async runTableLifecyclePass'),
      fleet.indexOf('private async spawnOverflowTables')
    );
    expect(body).toContain('try {');
    expect(body).toContain('reportError(');
    // Every failure path returns rather than throwing into the cycle.
    expect(body).toContain('return;');
  });
});

describe('auto_restart reaches the column from the live creation path', () => {
  // 2026-08-27: this block used to pin the CreateTableModal path
  // (settings-blob mirror in TableService.createTable). That entire path was
  // unreachable dead code — the modal had zero imports — and was deleted in
  // the create-flow audit. The live writer is TableConfigPage.buildTableData,
  // which writes the column directly.
  it('TableConfigPage writes the column the lifecycle pass reads', () => {
    const page = src('src/pages/TableConfigPage.tsx');
    expect(page).toContain('auto_restart: config.autoRestart');
  });

  it('the dead modal path stayed deleted', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'src/components/club/CreateTableModal.tsx'))
    ).toBe(false);
  });
});

describe('the tooltips say what the switches actually do', () => {
  const page = src('src/pages/TableConfigPage.tsx');

  it('Auto Restart has one at all now', () => {
    expect(page).toContain('Reopen This Table If It Closes');
  });

  it('Auto Extension says what it extends', () => {
    // "Extend table automatically" left a host guessing what was extended.
    expect(page).toContain('Keep This Table Open When It Empties');
    expect(page).not.toContain('Extend table automatically');
  });

  it('Auto Create Table was already clear and is unchanged', () => {
    expect(page).toContain('Create New Table When Full');
  });
});
