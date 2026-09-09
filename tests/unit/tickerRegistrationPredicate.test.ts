/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TICKER'S "YOU ARE REGISTERED" BADGE HAS TO BE ABLE TO MATCH A ROW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * TournamentStartingTicker filtered the player's own entries with
 * `.in('status', ['REGISTERED'])`. tournament_players.status is written in
 * LOWER case by the authoritative registration RPC ('registered' on entry,
 * flipped to 'playing' when the tournament starts), so that predicate matched zero rows and the
 * badge could never render for anybody.
 *
 * Production, checked before the change rather than after:
 *   eliminated 80,928 | winner 15,238 | playing 1,314 | registered 20
 *
 * A one-word casing slip is invisible in review and silent at runtime - the
 * query succeeds, it just answers "no". This pins the casing at the only place
 * it can be pinned cheaply: the source of the query itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TICKER = resolve(__dirname, '../../src/components/tournament/TournamentStartingTicker.tsx');
const SERVICE = resolve(__dirname, '../../src/services/TournamentService.ts');

describe('TournamentStartingTicker registration predicate', () => {
  const src = readFileSync(TICKER, 'utf8');

  it('never filters tournament_players on an upper-case status value', () => {
    // Deliberately narrow: `tournaments.status` IS upper case in this schema
    // ('ANNOUNCED', 'REGISTERING'), and the query right below this one filters
    // on it correctly. Only the tournament_players predicate is pinned, and
    // only where it is actually written.
    const statusFilters = src.match(/\.in\('status',\s*\[[^\]]*\]\)/g) ?? [];
    expect(statusFilters.length).toBeGreaterThan(0);
    // Tournament-status filters are upper case by schema — the starting-soon
    // query uses ANNOUNCED/REGISTERING and the overlay query (2026-08-26,
    // running events only) uses RUNNING/LATE_REG. Everything else is a
    // tournament_players predicate and must stay lower case.
    const playerFilters = statusFilters.filter(
      (f) => !/ANNOUNCED|REGISTERING|RUNNING|LATE_REG/.test(f)
    );
    expect(playerFilters.length).toBeGreaterThan(0);
    for (const f of playerFilters) {
      expect(f).not.toMatch(/[A-Z]{2,}/);
    }
  });

  it('asks for the lower-case values the engine actually writes', () => {
    expect(src).toMatch(/\.in\('status',\s*\['registered',\s*'playing'\]\)/);
  });

  it('delegates entry to the authoritative RPC instead of writing another vocabulary', () => {
    // TournamentService no longer owns the roster write. Pin the actual
    // architecture: the browser calls the one registration RPC and never
    // inserts a competing status value itself.
    const service = readFileSync(SERVICE, 'utf8');
    const start = service.indexOf('async registerPlayer(');
    const end = service.indexOf('async unregisterPlayer(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const registration = service.slice(start, end);
    expect(registration).toMatch(/\.rpc\(\s*'fn_register_for_tournament_request'/);
    expect(registration).not.toMatch(/\.from\(\s*'tournament_players'\s*\)\s*\.insert\(/);
  });
});
