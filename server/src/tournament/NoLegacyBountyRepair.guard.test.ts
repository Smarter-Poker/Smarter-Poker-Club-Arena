/**
 * Bounty recovery may retry only obligations created by the atomic knockout
 * path. Historical tournament/player/hand state is not authority to invent a
 * missing money obligation after the fact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const SQL = read(
  '../supabase/migrations/20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
);
const ELIMINATIONS = read('src/tournament/TournamentManagerEliminations.ts');
const RECOVERY = read('src/tournament/tournamentRecovery.ts');
const GAME_SERVER = read('src/GameServer.ts');
const MANIFEST = JSON.parse(
  read('../scripts/ci/schema-manifest.d/live-realtime-bounty-outbox.json')
) as { functions?: string[] };

const functionBody = (name: string): string => {
  const start = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = SQL.indexOf('$function$;', start);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  expect(end, `${name} must have a complete body`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('bounty recovery is an outbox consumer, never a repair writer', () => {
  it('removes both legacy backfill RPCs instead of hiding or retaining them', () => {
    for (const name of [
      'fn_backfill_legacy_tournament_bounty_obligations',
      'fn_backfill_legacy_tournament_bounty_obligations_page',
    ]) {
      expect(SQL).not.toMatch(
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'i')
      );
      expect(SQL).toContain(`DROP FUNCTION IF EXISTS public.${name}(uuid,integer);`);
      expect(MANIFEST.functions ?? []).not.toContain(name);
    }
  });

  it('sweeps only existing atomic obligations and never reconstructs missing work', () => {
    const sweep = functionBody('fn_sweep_pending_tournament_bounties');
    expect(sweep).toContain('FROM public.tournament_bounty_obligations bo');
    expect(sweep).toContain("bo.state = 'pending'");
    expect(sweep).toContain('public.fn_collect_bounty_obligation(o.id)');
    for (const forbidden of [
      'fn_backfill_legacy_tournament_bounty_obligations',
      'fn_claim_tournament_bounty_elimination',
      'tournament_players',
      'settlement_idempotency_keys',
      'hand_history',
      'backfilled',
      'backfill_may_have_more',
    ]) {
      expect(sweep).not.toContain(forbidden);
    }
  });

  it('does not reconstruct a missing obligation in payout or completion verdicts', () => {
    for (const name of ['fn_collect_bounty', 'fn_mystery_bounty_reserve']) {
      expect(functionBody(name)).not.toContain('fn_backfill_legacy_tournament_bounty_obligations');
    }
    const verdict = functionBody('fn_tournament_has_unsettled_bounties');
    expect(verdict).toContain('FROM public.tournament_bounty_obligations o');
    expect(verdict).not.toContain('FROM public.tournament_players');
    expect(verdict).not.toContain('settlement_idempotency_keys');
    expect(verdict).not.toContain('hand_history');
  });

  it('removes legacy continuation protocol from every active TypeScript client', () => {
    const clients = `${ELIMINATIONS}\n${RECOVERY}\n${GAME_SERVER}`;
    for (const legacySurface of [
      'fn_backfill_legacy_tournament_bounty_obligations',
      'backfilled',
      'backfill_may_have_more',
      'backfillMayHaveMore',
      'bounty_backfill_continue',
    ]) {
      expect(clients).not.toContain(legacySurface);
    }
  });

  it('preserves the status and obligation write in the atomic claim transaction', () => {
    const claim = functionBody('fn_claim_tournament_bounty_elimination');
    expect(claim).toContain('UPDATE public.tournament_players');
    expect(claim).toContain('INSERT INTO public.tournament_bounty_obligations');
    expect(claim).not.toContain("v_player.status = 'eliminated'");
    expect(claim).not.toContain(
      "v_t.status,'')\n           NOT IN ('RUNNING','COMPLETING','COMPLETED')"
    );
    expect(claim).not.toContain('legacy_place_not_paid');
    expect(claim).not.toContain(
      'UPDATE public.tournament_bounty_awards a SET bounty_obligation_id='
    );
    expect(claim.indexOf('UPDATE public.tournament_players')).toBeLessThan(
      claim.indexOf('INSERT INTO public.tournament_bounty_obligations')
    );
  });
});
