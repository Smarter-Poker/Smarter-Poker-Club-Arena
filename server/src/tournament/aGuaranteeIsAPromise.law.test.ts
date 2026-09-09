/** An advertised guarantee is funded inside the same transaction that pays it. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const migrations = join(process.cwd(), '..', 'supabase', 'migrations');
const stripSqlComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

function newestFunction(name: string, requiredFragment?: string): string {
  let newest = '';
  for (const file of readdirSync(migrations)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const sql = stripSqlComments(readFileSync(join(migrations, file), 'utf8'));
    let start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    while (start >= 0) {
      const body = sql.indexOf('AS $', start);
      if (body < 0) throw new Error(`${file}: ${name} has no body`);
      const tagEnd = sql.indexOf('$', body + 4);
      const tag = sql.slice(body + 3, tagEnd + 1);
      const end = sql.indexOf(`${tag};`, tagEnd + 1);
      if (end < 0) throw new Error(`${file}: ${name} has an incomplete body`);
      const definition = sql.slice(start, end + tag.length + 1);
      if (!requiredFragment || definition.includes(requiredFragment)) newest = definition;
      start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, end + tag.length + 1);
    }
  }
  if (!newest) throw new Error(`${name} is missing`);
  return newest;
}

const places = newestFunction('fn_settle_tournament_places');
const deal = newestFunction('fn_settle_tournament_final_table_deal');
const terminal = newestFunction(
  'fn_complete_tournament_terminal',
  'public.fn_settle_tournament_places('
);
const terminalSeatAuthority = newestFunction('fn_complete_tournament_terminal');
const eliminations = blankNonCode(
  readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8')
);
const recovery = blankNonCode(
  sliceMethod(
    readFileSync('src/tournament/tournamentRecovery.ts', 'utf8'),
    'export async function recoverStuckCompletingTournaments('
  )
);
const reconciler = readFileSync('src/services/FeeReconciler.ts', 'utf8');
const gameServer = readFileSync('src/GameServer.ts', 'utf8');

describe('ordinary finish funds the guarantee inside its cash transaction', () => {
  it.each([
    [places, 'engine.fn_settle_tournament_places'],
    [deal, 'engine.fn_settle_tournament_final_table_deal'],
  ])('funds and proves the locked pool before deriving a payout', (authority, source) => {
    const satelliteRefusal =
      authority.indexOf('satellite_has_its_own_settlement') >= 0
        ? authority.indexOf('satellite_has_its_own_settlement')
        : authority.indexOf('is a satellite');
    const fund = authority.indexOf('public.fn_apply_prize_guarantee(');
    const sourceAt = authority.indexOf(`'${source}'`, fund);
    const receiptProof = authority.indexOf("v_guarantee_result->>'overlay_journaled'", fund);
    const refresh = authority.indexOf('INTO v_t', receiptProof);
    const finalized = authority.indexOf('prize_pool_finalized', refresh);
    const poolFloor = authority.indexOf('guaranteed_prize', finalized);
    const pricing = Math.min(
      ...[
        authority.indexOf('fn_ca_tournament_place_amounts', poolFloor),
        authority.indexOf('v_total_chips', poolFloor),
      ].filter((index) => index >= 0)
    );

    expect(satelliteRefusal).toBeGreaterThan(-1);
    expect(fund).toBeGreaterThan(satelliteRefusal);
    expect(sourceAt).toBeGreaterThan(fund);
    expect(receiptProof).toBeGreaterThan(sourceAt);
    expect(refresh).toBeGreaterThan(receiptProof);
    expect(finalized).toBeGreaterThan(refresh);
    expect(poolFloor).toBeGreaterThan(finalized);
    expect(pricing).toBeGreaterThan(poolFloor);
  });

  it.each([places, deal])('raises on a refused or unjournaled overlay', (authority) => {
    expect(authority).toMatch(
      /v_guarantee_result := public\.fn_apply_prize_guarantee\([\s\S]*?overlay_journaled[\s\S]*?RAISE EXCEPTION/
    );
    expect(authority).toMatch(
      /prize_pool_finalized[\s\S]*?prize_pool[\s\S]*?guaranteed_prize[\s\S]*?RAISE EXCEPTION/
    );
  });

  it('keeps guarantee funding, every payout, bounty, rake, closure and receipt in one terminal call', () => {
    const placesCall = terminal.indexOf('public.fn_settle_tournament_places(');
    const dealCall = terminal.indexOf('public.fn_settle_tournament_final_table_deal(');
    const complete = terminal.indexOf("SET status = 'COMPLETED'");
    const receipt = terminal.indexOf('tournament_terminal_settlements', complete);
    expect(placesCall).toBeGreaterThan(-1);
    expect(dealCall).toBeGreaterThan(placesCall);
    expect(complete).toBeGreaterThan(dealCall);
    expect(receipt).toBeGreaterThan(complete);
    expect(terminalSeatAuthority).toMatch(
      /fn_ca_open_tournament_seat_exit_authority[\s\S]*?fn_complete_tournament_terminal_pre_seat_guard/
    );
  });
});

describe('the process never funds a guarantee as a separate commit', () => {
  it('live finish and recovery request the terminal receipt only', () => {
    expect(eliminations).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(recovery).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(eliminations).not.toMatch(/fn_apply_prize_guarantee|applyPrizeGuarantee\(/);
    expect(recovery).not.toMatch(/fn_apply_prize_guarantee|applyPrizeGuarantee\(/);
  });

  it('recovery proves result evidence before asking the atomic authority', () => {
    const field = recovery.indexOf('fieldIsStillLive(');
    const survivors = recovery.indexOf('if (live.length > 1)', field);
    const hand = recovery.indexOf('await hasHandEvidence(tournament)', survivors);
    const settle = recovery.indexOf('requestTournamentTerminalReceipt(', hand);
    expect(field).toBeGreaterThan(-1);
    expect(survivors).toBeGreaterThan(field);
    expect(hand).toBeGreaterThan(survivors);
    expect(settle).toBeGreaterThan(hand);
    expect(recovery.slice(0, settle)).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  });
});

describe('the independent guarantee audit detects but never repairs', () => {
  it('is wired beside the other periodic integrity checks', () => {
    expect(reconciler).toMatch(/export async function auditGuaranteesKept/);
    expect(reconciler).toMatch(/fn_tournament_guarantee_check/);
    expect(gameServer).toMatch(/auditGuaranteesKept\(24\)/);
    expect(gameServer).toMatch(/auditGuaranteesKept,/);
  });

  it('contains no guarantee or wallet payer', () => {
    const audit = reconciler.slice(
      reconciler.indexOf('export async function auditGuaranteesKept'),
      reconciler.indexOf('export async function auditSatelliteConservation')
    );
    expect(audit).not.toMatch(/fn_credit_and_log|fn_apply_prize_guarantee|credit_player_wallet/);
  });
});
