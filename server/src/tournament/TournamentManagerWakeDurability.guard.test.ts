/**
 * Durable tournament-manager wakes are exact work receipts, not an identity
 * high-water mark. PostgreSQL sequence allocation is not commit ordered, so
 * acknowledging `id <= n` can consume a transaction the manager never saw.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceSqlStatement } from '../testHelpers/sourceWindow.js';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const GAME_SERVER = read('src/GameServer.ts');
const BASE = read('src/tournament/TournamentManagerBase.ts');
const ELIMINATIONS = read('src/tournament/TournamentManagerEliminations.ts');
const MIGRATION = read(
  join(
    '..',
    'supabase',
    'migrations',
    '20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
  )
);

describe('durable tournament-manager wake ownership', () => {
  it('survives boot gaps, channel errors, and permanent channel closure', () => {
    const start = GAME_SERVER.indexOf('private startTournamentManagerWakeSubscription()');
    const end = GAME_SERVER.indexOf('private async admitTournamentManagerWake(', start);
    const subscription = GAME_SERVER.slice(start, end);
    expect(subscription).toContain('this.tournamentManagerWakeChannel = channel;');
    expect(subscription).toContain('this.tournamentManagerWakeChannel !== channel');
    expect(subscription).toContain("status === 'SUBSCRIBED'");
    expect(subscription).toContain("status === 'CHANNEL_ERROR'");
    expect(subscription).toContain("status === 'TIMED_OUT'");
    expect(subscription).toContain("status === 'CLOSED'");
    expect(subscription).toContain('this.scheduleTournamentManagerWakeSubscriptionReconnect()');
    expect(subscription).toContain("'GameServer.tournament_manager_wake_boot_drain_failed'");
    expect(subscription).toContain("'GameServer.tournament_manager_wake_error_drain_failed'");
    expect(subscription).toContain("'GameServer.tournament_manager_wake_closed_drain_failed'");
    expect(subscription).toContain("event: 'UPDATE'");
  });

  it('retains each admitted wake identity until that exact sweep succeeds', () => {
    expect(BASE).toContain('pendingManagerWakes = new Map<number, string>()');
    expect(BASE).toContain('this.pendingManagerWakes.set(Number(durableWakeId)');
    expect(BASE).not.toContain('pendingManagerWakeHighWater');

    expect(ELIMINATIONS).toContain('pendingManagerWakeGenerations');
    expect(ELIMINATIONS).toContain('const durableWakeReceipts: TournamentManagerWakeReceipt[] =');
    expect(ELIMINATIONS).toContain(
      'acknowledgeTournamentManagerWakes(\n        this.tournamentId,\n        durableWakeReceipts'
    );
    expect(ELIMINATIONS).toContain('this.pendingManagerWakes.delete(receipt.id)');
  });

  it('acknowledges an exact validated set, never an identity range', () => {
    const start = MIGRATION.indexOf('FUNCTION public.fn_ack_tournament_manager_wakes(');
    const end = MIGRATION.indexOf('$function$;', start);
    const rpc = MIGRATION.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(rpc).toContain('w.id=ANY(v_ids)');
    expect(rpc).toContain('v_found<>cardinality(v_ids)');
    expect(rpc).toContain('w.generation=requested.generation');
    expect(rpc).toContain("'current_receipts'");
    expect(rpc).not.toMatch(/w\.id\s*<=|id\s*<=\s*p_/);

    const gameStart = GAME_SERVER.indexOf('async acknowledgeTournamentManagerWakes(');
    const gameEnd = GAME_SERVER.indexOf('private async drainTournamentManagerWakes', gameStart);
    const gameAck = GAME_SERVER.slice(gameStart, gameEnd);
    expect(gameAck).toContain("supabase.rpc('fn_ack_tournament_manager_wakes'");
    expect(gameAck).toContain('chunkTournamentManagerWakeReceipts');
    expect(gameAck).toContain('p_wake_ids: chunk.map((wake) => wake.id)');
    expect(gameAck).toContain('p_wake_generations: chunk.map((wake) => wake.generation)');
    expect(gameAck).not.toMatch(/highWater|\.lte\('id'/);
  });

  it('drains every bounded page with a monotonic keyset cursor', () => {
    const start = GAME_SERVER.indexOf('private async drainTournamentManagerWakePages(');
    const end = GAME_SERVER.indexOf('private async sweepPendingTournamentBounties', start);
    const drain = GAME_SERVER.slice(start, end);
    expect(drain).toContain(".gt('id', afterId)");
    expect(drain).toContain('for (;;)');
    expect(drain).toContain('if (rows.length < pageSize) return');
    expect(drain).toContain('setImmediate(resolve)');
    expect(drain).toContain('GameServer.tournament_manager_wake_drain_read_threw');
    expect(drain).toContain('return false;');
    expect(drain).not.toMatch(/\.lte\('id'|pendingManagerWakeHighWater/);
  });

  it('latches a global cause that arrives during the final snapshot page', () => {
    const start = GAME_SERVER.indexOf('private async drainTournamentManagerWakes(');
    const end = GAME_SERVER.indexOf('private async drainTournamentManagerWakePages(', start);
    const owner = GAME_SERVER.slice(start, end);
    expect(owner).toContain('this.tournamentManagerWakeDrainRequested = true;');
    expect(owner).toContain('if (this.tournamentManagerWakeDrainInFlight) return;');
    expect(owner).toContain('while (this.running && this.tournamentManagerWakeDrainRequested)');
    expect(owner).toContain('this.tournamentManagerWakeDrainRequested = false;');
    expect(owner).toMatch(
      /if \(\s*this\.running &&\s*this\.tournamentManagerWakeDrainRequested &&\s*!this\.tournamentManagerWakeDrainRetryTimer\s*\)/
    );
    expect(owner).toContain('this.scheduleTournamentManagerWakeDrainRetry()');
    expect(owner).toContain('this.tournamentManagerWakeDrainRetryTimer');
    expect(GAME_SERVER).toContain('this.tournamentManagerWakeDrainRequested = false;');
  });

  it('coalesces one unconsumed wake without allowing an in-flight generation to be lost', () => {
    expect(MIGRATION).toContain('generation bigint NOT NULL DEFAULT 1');
    expect(MIGRATION).toContain('uq_tournament_manager_wakes_pending_by_reason');
    const emitStart = MIGRATION.indexOf('FUNCTION public.fn_emit_tournament_manager_wake(');
    const emitEnd = MIGRATION.indexOf('$function$;', emitStart);
    const emit = MIGRATION.slice(emitStart, emitEnd);
    expect(emit).toContain('FROM public.tournaments');
    expect(emit).toContain('FOR SHARE');
    expect(emit).toContain("IN ('COMPLETED','CANCELLED','CANCELED')");
    expect(emit).toContain('RETURN NULL;');
    expect(emit).toContain('ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL');
    expect(emit).toContain('generation=pending.generation+1');
  });

  it('emits a durable manager wake in the same transaction that settles a bounty', () => {
    expect(MIGRATION).toContain("'bounty_settled'");
    expect(MIGRATION).toContain('fn_emit_manager_wake_for_settled_bounty');
    expect(MIGRATION).toContain('trg_emit_manager_wake_for_settled_bounty');
  });

  it('retires every pending wake only inside the successful terminal transaction', () => {
    const retire = sliceSqlStatement(
      MIGRATION,
      'CREATE OR REPLACE FUNCTION public.fn_retire_manager_wakes_after_terminal_status()'
    );
    expect(retire).toContain("IN ('COMPLETED','CANCELLED','CANCELED')");
    expect(retire).toContain('NEW.status IS DISTINCT FROM OLD.status');
    expect(retire).toContain('UPDATE public.tournament_manager_wakes');
    expect(retire).toContain('consumed_at=COALESCE(consumed_at,clock_timestamp())');
    expect(retire).toContain('tournament_id=NEW.id AND consumed_at IS NULL');
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER trg_retire_manager_wakes_after_terminal_status\s+AFTER UPDATE OF status ON public\.tournaments/
    );
  });

  it('does not grant the service process direct write access around the RPC', () => {
    expect(MIGRATION).toContain(
      'REVOKE ALL ON TABLE public.tournament_manager_wakes FROM PUBLIC,anon,authenticated,service_role'
    );
    expect(MIGRATION).toContain(
      'GRANT SELECT ON TABLE public.tournament_manager_wakes TO service_role'
    );
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ack_tournament_manager_wakes(uuid,bigint[],bigint[])'
    );
  });
});
