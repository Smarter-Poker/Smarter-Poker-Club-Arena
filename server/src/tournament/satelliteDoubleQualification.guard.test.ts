/**
 * A SECOND SATELLITE WIN IS NEVER WORTH ZERO — and the DB gate agrees with
 * the TS gate about what "open" means (2026-08-30 satellite audit).
 *
 * Source-pin guard in the moneyPathAudit style: every pin below is a bug that
 * shipped.
 *
 *   1. fn_award_satellite_seat refused RUNNING targets outright while
 *      isSatelliteTargetOpen (PR #1935) approved them inside late
 *      registration — so the exact case #1935 existed for still cashed out.
 *      The two gates must express the same rule.
 *
 *   2. The unique_violation dedupe returned ok=true/awarded=false and the
 *      engine logged "Seat awarded". A player who won seats in two
 *      satellites got one seat and NOTHING for the second win — four times
 *      in one week (1a6f53a4, acb14548, e3d3bd1e x2). The fn now reports
 *      held_from_this_satellite and the engine pays ticket value in cash
 *      for a cross-satellite double win, under the stable place key so a
 *      recovery re-drive still dedupes.
 *
 *   3. The prize stamp write discarded its error: every e3d3bd1e winner was
 *      recorded at prize 0 while holding a funded seat.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = fs.readFileSync(path.join(HERE, 'TournamentManager.ts'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', '..', '..', 'supabase', 'migrations');

function latestMigrationContaining(needle: string): string {
  const owning = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').includes(needle));
  if (owning.length === 0) throw new Error(`no migration contains ${needle}`);
  return fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8');
}

function functionDefinitions(name: string): string[] {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const definitions: string[] = [];
  for (const file of fs
    .readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const source = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    let from = 0;
    for (;;) {
      const start = source.indexOf(marker, from);
      if (start < 0) break;
      const bodyHeader = source.slice(start).match(/\bAS\s+(\$[A-Za-z_]*\$)/);
      const delimiter = bodyHeader?.[1];
      const bodyStart = bodyHeader?.index == null ? -1 : start + bodyHeader.index;
      const closeFrom = bodyStart < 0 || !bodyHeader ? -1 : bodyStart + bodyHeader[0].length;
      const escapedDelimiter = delimiter?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const closing =
        closeFrom >= 0 && escapedDelimiter
          ? source.slice(closeFrom).match(new RegExp(`${escapedDelimiter}\\s*;`))
          : null;
      const end = closing?.index == null ? -1 : closeFrom + closing.index;
      if (bodyStart < 0 || end < 0 || !delimiter || !closing) {
        throw new Error(`SQL function ${name} has no complete body in ${file}`);
      }
      definitions.push(source.slice(start, end + closing[0].length));
      from = end + closing[0].length;
    }
  }
  return definitions;
}

/**
 * Select the newest substantive body, not a later migration that merely
 * mentions the function in an assertion, ACL, rename, or ownership wrapper.
 */
function latestFunction(name: string, required = ''): string {
  const definitions = functionDefinitions(name).filter(
    (definition) => !required || definition.includes(required)
  );
  if (definitions.length === 0) throw new Error(`SQL function ${name} is missing`);
  return definitions[definitions.length - 1];
}

const AWARD = latestFunction('fn_award_satellite_seat', 'held_from_this_satellite');
const AWARD_ASSERTIONS = latestMigrationContaining(
  'the seat gate no longer reads RUNNING / late_reg_levels / rebuy_levels'
);
const ATOMIC_FINISH = latestFunction('fn_settle_satellite_finish_atomic', 'v_batch.settled_at');
const EXACT_DELIVERY = latestFunction(
  'fn_deliver_satellite_ticket_exact',
  'seat_already_held_elsewhere'
);
const EXACT_CASH = latestFunction(
  'fn_settle_satellite_cash_entitlement_exact',
  'satellite cash entitlement did not settle exactly'
);

describe('the DB seat gate agrees with the TS seat gate', () => {
  it('the latest fn_award_satellite_seat accepts a RUNNING target in late reg', () => {
    const sql = AWARD;
    expect(sql).toMatch(/RUNNING/);
    expect(sql).toMatch(/late_reg_levels/);
    expect(sql).toMatch(/rebuy_levels/);
  });

  it('the latest fn_award_satellite_seat names who seated a deduped winner', () => {
    const sql = AWARD;
    expect(sql).toMatch(/held_from_this_satellite/);
    expect(sql).toMatch(/source_satellite_id/);
  });

  /**
   * AND THEY AGREE ABOUT WHERE "OPEN" ENDS (2026-08-31).
   *
   * The two gates agreed that a RUNNING target in late reg is open and then
   * disagreed by one level about when late reg stops, because
   * `tournaments.current_level` is a ZERO-BASED index and the DB gate closed on
   * `> v_cap` while every other reader on the platform closes on `>=`. The DB
   * gate also never read `prize_pool_finalized`, so it would seat a winner into
   * an event whose payout ladder had already been sized — inserting a
   * tournament_players row, a buy-in into the finalized prize_pool, a rake row
   * and a payout row after the fact.
   *
   * `isSatelliteTargetOpen` above is pinned at the same boundary by
   * satelliteTargetOpen.test.ts. These two pins are the same rule, once on
   * each side of the wire.
   */
  it('the latest fn_award_satellite_seat closes AT the cap, not one level past it', () => {
    const sql = AWARD;
    expect(sql).toContain('fn_tournament_late_registration_open(p_target_id)');
    const admission = latestFunction('fn_tournament_late_registration_open');
    expect(admission).toMatch(
      /COALESCE\(t\.current_level,0\)\s*<\s*COALESCE\(t\.late_reg_levels,t\.rebuy_levels,0\)/
    );
    expect(admission).toMatch(
      /clock_timestamp\(\)\s*<\s*t\.started_at\s*\+\s*make_interval\(mins\s*=>\s*t\.late_reg_mins\)/
    );
    // The post-apply assertion that the off-by-one cannot come back.
    expect(AWARD_ASSERTIONS).toMatch(/the off-by-one level guard survived the rewrite/);
  });

  it('the latest fn_award_satellite_seat refuses a finalized prize pool', () => {
    const sql = AWARD;
    expect(sql).toMatch(/prize_pool_finalized/);
    expect(sql).toMatch(/target_pool_finalized/);
  });
});

describe('a cross-satellite double win pays the ticket value', () => {
  it('the locked domain helper distinguishes this satellite from a seat held elsewhere', () => {
    expect(EXACT_DELIVERY).toMatch(
      /v_existing\.source_satellite_id=p_satellite_id[\s\S]*?RETURN jsonb_build_object\('delivery','seat','already',true/
    );
    expect(EXACT_DELIVERY).toMatch(
      /RETURN jsonb_build_object\('delivery','cash','reason','seat_already_held_elsewhere'\)/
    );
  });

  it('cash fallback lands on the frozen place obligation inside the atomic finish', () => {
    expect(ATOMIC_FINISH).toMatch(
      /IF v_delivery->>'delivery'='cash' THEN[\s\S]*?fn_settle_satellite_cash_entitlement_exact\([\s\S]*?p_tournament_id,'place',e\.position,p\.user_id,e\.ticket_value/
    );
    expect(EXACT_CASH).toMatch(
      /fn_settle_tournament_obligation_before_atomic_batch_gate\([\s\S]*?p_tournament_id,p_kind,p_place,p_user_id,round\(p_amount,2\),p_source/
    );
    expect(EXACT_CASH).toMatch(
      /count\(\*\)::integer[\s\S]*?o\.kind=p_kind[\s\S]*?o\.user_id=p_user_id[\s\S]*?o\.place IS NOT DISTINCT FROM p_place[\s\S]*?round\(o\.amount_paid,2\)=round\(p_amount,2\)[\s\S]*?o\.settled_at IS NOT NULL[\s\S]*?v_count<>1[\s\S]*?RAISE EXCEPTION/
    );
  });

  it('a genuine re-drive proves the settled batch and moves nothing extra', () => {
    expect(ATOMIC_FINISH).toMatch(
      /IF FOUND AND v_batch\.settled_at IS NOT NULL THEN[\s\S]*?fn_check_atomic_satellite_finish\(p_tournament_id\)[\s\S]*?'already_settled',true[\s\S]*?'rows_updated',0/
    );
  });
});

describe('the gate is given the columns it decides on', () => {
  /**
   * A gate that reads a column the query never selected returns `undefined`,
   * which is falsy, which silently means "not finalized" — the exact bug the
   * finalized check exists to close. The select list and the gate have to move
   * together.
   */
  it('the atomic helper locks the complete target row before deciding seat or cash', () => {
    expect(EXACT_DELIVERY).toMatch(
      /SELECT \* INTO v_target FROM public\.tournaments[\s\S]*?WHERE id=p_target_id FOR UPDATE/
    );
    expect(EXACT_DELIVERY).toMatch(/WHEN v_target\.status IN \('ANNOUNCED','REGISTERING'\)/);
    expect(EXACT_DELIVERY).toMatch(/NOT COALESCE\(v_target\.prize_pool_finalized,false\)/);
    expect(EXACT_DELIVERY).toMatch(/public\.fn_tournament_late_registration_open\(p_target_id\)/);
    expect(EXACT_DELIVERY).toMatch(
      /v_target\.max_players IS NULL OR v_count<v_target\.max_players/
    );
    expect(EXACT_DELIVERY).toMatch(/<>round\(p_ticket_value,2\)/);
  });
});

describe('the prize stamp is a checked write', () => {
  it('a failed stamp aborts the entire satellite settlement subtransaction', () => {
    expect(ATOMIC_FINISH).toMatch(
      /UPDATE public\.tournament_players[\s\S]*?SET prize=round\(e\.ticket_value\+e\.remainder_value,2\)[\s\S]*?GET DIAGNOSTICS v_rows=ROW_COUNT;[\s\S]*?IF v_rows<>1 THEN[\s\S]*?RAISE EXCEPTION 'satellite prize stamp CAS changed % rows'/
    );
    expect(ATOMIC_FINISH).toMatch(
      /fn_check_atomic_satellite_finish\(p_tournament_id\)[\s\S]*?SET status='COMPLETED'[\s\S]*?EXCEPTION WHEN OTHERS THEN[\s\S]*?'settled',false/
    );
  });
});

describe('the runtime is only a thin caller of the atomic domain finish', () => {
  it('contains no manual seat, cash, prize or status mutation path', () => {
    const runtime = sliceMethod(MANAGER, 'processSatelliteAwards(');
    expect(runtime).toContain('requestSatelliteSettlementReceipt(this.tournamentId, winnerId)');
    expect(runtime).toContain('return verified;');
    expect(runtime).not.toMatch(
      /supabase|\.from\(|fn_award_satellite_seat|fn_settle_tournament_obligation|status:\s*'COMPLETED'|\.update\(/
    );
  });
});

describe('a stuck satellite preserves its immutable finish claim', () => {
  it('an undecided COMPLETING satellite fails closed instead of reviving beside a receipt', () => {
    const recovery = fs.readFileSync(path.join(HERE, 'tournamentRecovery.ts'), 'utf8');
    expect(recovery).toMatch(/recoverStuckCompleting_satellite_live_field_conflict/);
    expect(recovery).toMatch(/live\.length > 1/);
    expect(recovery).not.toMatch(/recoverStuckCompleting_satellite_revived/);
    // A zero-survivor field still refuses structure cash without a canonical
    // winner, while one proven survivor resumes the atomic satellite path.
    expect(recovery).toMatch(/recoverStuckCompleting_satellite_winner_unproved/);
    expect(recovery).toMatch(/requestSatelliteSettlementReceipt\(tournament\.id, winnerId\)/);
    expect(recovery).not.toMatch(/fn_settle_satellite_finish_atomic/);
  });
});
