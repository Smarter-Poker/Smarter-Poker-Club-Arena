/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSES ARE PLAYERS — the table cannot tell them apart (Dan, 2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER
 * NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING
 * FOR THE CLUB ARENA. YES IT STILL NEEDS TO THE SAME 5 SECOND PAUSE TO REBUY.
 * NOT EVERY HORSE ALWAYS REBUYS IN THE CASH GAMES, AND IF YOU DIDN'T GIVE THEM
 * THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD NOTICE!"
 *
 * The bug this pins: the rebuy pause filtered `p.is_horse === false`, so the
 * table held five seconds when a human busted and rolled straight on when a
 * horse did. The tell is the RHYTHM of the table — a seat whose bust never
 * costs the table a beat is a seat anybody can identify as a horse.
 *
 * These are source-level guards rather than engine integration tests because
 * the defect is a one-token filter that reads as harmless in review, and it is
 * exactly the kind of thing that gets reintroduced by someone "optimising" a
 * pause away. See CLAUDE.md section 10.5.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const DEALING = 'server/src/engine/ServerTableEngineDealing.ts';

describe('the bust/rebuy pause is identical for horses and humans', () => {
  it('pauses for every busted player, with no horse filter', () => {
    const src = read(DEALING);
    // The pause population must not be narrowed to humans.
    expect(src).toMatch(
      /const justBustedPlayers = activePlayers\.filter\(\(p\) => p\.stack === 0\)/
    );
    expect(src).not.toMatch(/justBustedHumans/);
  });

  it('never re-introduces an is_horse test in the bust filter', () => {
    const src = read(DEALING);
    const start =
      src.indexOf('Dan’s Rebuy Pause') >= 0
        ? src.indexOf('Dan’s Rebuy Pause')
        : src.indexOf("Dan's Rebuy Pause");
    expect(start).toBeGreaterThan(-1);
    // The filter that decides WHO the table waits for may not consult is_horse.
    // Pinned to the declaration itself, so it cannot drift out of a window.
    const filterLine = sliceStatement(src, 'const justBustedPlayers =');
    expect(filterLine).not.toMatch(/is_horse/);
  });

  it('still actually pauses (the window is what a busted player is owed)', () => {
    const src = read(DEALING);
    expect(src).toMatch(/setLoopPhase\('rebuy_pause'\)/);
    expect(src).toMatch(/await this\.sleep\(5000\)/);
  });
});

describe('the law is written down where the next agent will read it', () => {
  it('CLAUDE.md carries the binding section and forbids the carve-out', () => {
    const md = read('CLAUDE.md');
    expect(md).toMatch(/HORSES ARE PLAYERS/);
    expect(md).toMatch(/NO "EQUAL OUTCOME BY A DIFFERENT MECHANISM" EXEMPTION/);
    expect(md).toMatch(/TIMING IS PART OF THE TREATMENT/);
  });
});
