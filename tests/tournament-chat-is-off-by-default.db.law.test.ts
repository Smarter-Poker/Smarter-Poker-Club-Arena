/**
 * ===========================================================================
 *  LAW - TOURNAMENT CHAT IS OFF BY DEFAULT; SPINS AND SIT N GOS MAY CHAT
 * ===========================================================================
 *
 * Dan, 2026-10-11: "Off by default for all tournaments. Spins and Sit N Gos
 * can have chat on." Measured on production that day: 1,927 MTT-family events
 * created in 14 days and not one with chat banned. Three writers decided it,
 * and none of them was the create screen: the engine's recurring creator
 * inserts without a ban_chat column (the column default was false), the
 * schedule spawner writes asBool(config.banChat) and no schedule said, and the
 * governed creator wrote COALESCE(banChat, false).
 *
 * Migration 20261012040851 moves the default into the database without an
 * engine release: ban_chat has no column default and a BEFORE INSERT trigger
 * fills an omitted value (true unless SPIN or SNG), the governed creator
 * defaults by type, and an MTT-family schedule config that does not say is
 * given banChat true. scripts/ci/test-tournament-chat-default-db-postgres.py
 * qualifies it on PostgreSQL 17 against the creator rebuilt byte for byte from
 * main's migrations (17 of 39 cases fail before, 39 pass after). This law pins
 * the shapes that would quietly bring chat back: an engine writer that starts
 * sending false, a creator default flipped back, a backfill that reaches a
 * running event, and the create screen sending chat off for a Spin.
 *
 * Registry: docs/laws.d/tournament-chat-is-off-by-default.md
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
import { migrationText } from './helpers/migrationCorpus';

const FILE = '20261012040851_tournament_chat_is_off_by_default.sql';
const MIG = migrationText(FILE);
const read = (p: string): string => readFileSync(p, 'utf8');
const PRE = 'bf284ab7932447a7d2e49a1fa7deb9d8';
const POST =
  /-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_create_tournament_governed_legacy\(uuid,jsonb\)'::regprocedure\)\) = '([0-9a-f]{32})'\)/.exec(
    MIG
  )?.[1];

describe('tournament chat is off by default', () => {
  it('replaces production`s governed creator by one counted substitution, pinned before and after', () => {
    expect(POST).toMatch(/^[0-9a-f]{32}$/);
    expect(MIG).toContain(`IF md5(v_def) <> '${PRE}' THEN`);
    expect(MIG.split(POST!).length - 1).toBe(3);
    expect(MIG).toContain(
      "v_anchor text := $a$    COALESCE((p_config->>'banChat')::boolean, false),\n$a$;"
    );
    expect(MIG).toContain(
      "COALESCE((p_config->>'banChat')::boolean, v_type NOT IN ('sng', 'spin')),"
    );
    expect(MIG).toContain('TOURNAMENT_CHAT_DEFAULT_METADATA');
  });

  it('fills only an omitted ban_chat, and never a Spin or a Sit N Go', () => {
    expect(MIG).toContain('ALTER TABLE public.tournaments ALTER COLUMN ban_chat DROP DEFAULT;');
    expect(MIG).toContain('IF NEW.ban_chat IS NULL THEN');
    expect(MIG).toContain("NOT IN ('SPIN', 'SNG');");
    expect(MIG).toMatch(
      /CREATE OR REPLACE TRIGGER a00_tournaments_chat_default\s+BEFORE INSERT ON public\.tournaments/
    );
    expect(MIG).toMatch(/VALUES \('tournaments', 'a00_tournaments_chat_default',/);
    expect(MIG).toMatch(
      /CREATE OR REPLACE TRIGGER a00_tournament_schedules_chat_default\s+BEFORE INSERT OR UPDATE OF config ON public\.tournament_schedules/
    );
    expect(MIG).toContain("IN ('spin', 'sng', 'hu_sng', 'heads_up')");
  });

  it('switches only events that have not started, as the service role, and refuses any other column moving', () => {
    expect(MIG).toContain("WHERE t.status IN ('ANNOUNCED', 'REGISTERING')");
    for (const live of ['RUNNING', 'LATE_REG', 'COMPLETING', 'COMPLETED', 'CANCELLED'])
      expect(MIG).not.toContain(`t.status IN ('${live}'`);
    expect(MIG).toContain(
      `PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);`
    );
    expect(MIG).toContain(`PERFORM set_config('request.jwt.claims', '', true);`);
    expect(MIG).toContain('TOURNAMENT_CHAT_DEFAULT_SIDE_EFFECT');
    expect(MIG).toMatch(/^BEGIN;$/m);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('relies on engine writers that leave the default to the database', () => {
    // The scheduled spawner reads the flag from the config the database now fills.
    expect(read('server/src/services/ScheduledTournamentService.ts')).toContain(
      'ban_chat: asBool(cfg.banChat),'
    );
    // The recurring creator must not start sending chat on for its MTTs.
    expect(read('server/src/services/TournamentRecurringService.ts')).not.toMatch(
      /ban_chat:\s*false/
    );
  });

  it('the create screens send chat off for MTT-family events and chat on for Spins and Sit N Gos', () => {
    expect(read('src/components/club/CreateTournamentModal.tsx')).toContain(
      'const banChat = isSngOrSpin ? fixedFormatChatBanned : true;'
    );
    expect(read('src/lib/tournamentFromTableConfig.ts')).toContain(
      'banChat: isMtt ? true : (config.banChat ?? false),'
    );
  });

  it('an edit to the qualification alone still runs it', () => {
    for (const path of [
      'scripts/ci/test-tournament-chat-default-db-postgres.py',
      'tests/fixtures/tournament-chat-default-db/fixture.sql',
    ])
      expect(classifyChangedPaths([path]), path).toMatchObject({ server: true, tests: true });
  });
});
