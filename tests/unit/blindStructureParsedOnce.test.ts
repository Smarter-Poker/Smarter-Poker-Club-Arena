/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE BLIND STRUCTURE IS PARSED ONCE PER STRING, NOT ONCE PER CALL
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `tournaments.blind_structure` is a TEXT column and arrives from PostgREST as
 * a string. Nothing kept the parsed form, so every reader parsed it again from
 * the same unchanged string.
 *
 * On the tournament Detail tab that is once a SECOND for as long as the tab is
 * open: the `level` memo lists `tick` in its dependencies — correctly, the
 * clock has to count — and calls `getCurrentLevelState()`, which re-parses a
 * 40-level structure from scratch. The parse is not why the memo recomputes,
 * it is just carried along, sixty times a minute, to produce a result identical
 * to the one before it. The lobby does the same thing four times per card.
 *
 * This measures the parse, it does not assert the shape of the cache. Count
 * `JSON.parse` calls across repeated reads of one string: it must be 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseBlindStructure, parsePayoutStructure } from '../../src/utils/parseBlindStructure';
import { parseBlindStructure as parseLobby } from '../../src/components/lobby/tournamentFigures';
import {
  parseJsonCached,
  __clearParseJsonCache,
  __parseJsonCacheSize,
} from '../../src/utils/parseJsonCached';

/** A realistic structure: 40 levels, the size the Detail tab re-parses. */
const STRUCTURE = JSON.stringify(
  Array.from({ length: 40 }, (_, i) => ({
    level: i + 1,
    smallBlind: 25 * (i + 1),
    bigBlind: 50 * (i + 1),
    ante: i > 5 ? 5 * i : 0,
    durationMinutes: 15,
  }))
);

describe('a structure string is parsed once', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __clearParseJsonCache();
    spy = vi.spyOn(JSON, 'parse');
  });
  afterEach(() => spy.mockRestore());

  it('sixty reads of one string cost one parse, not sixty', () => {
    // Sixty is one minute of the Detail tab's clock.
    for (let i = 0; i < 60; i++) parseBlindStructure(STRUCTURE);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the lobby parser shares the same cache', () => {
    // Two independent implementations of "parse this column" exist, in
    // utils/parseBlindStructure and components/lobby/tournamentFigures. They
    // read the same strings, so they must not each pay for it.
    parseBlindStructure(STRUCTURE);
    parseLobby(STRUCTURE);
    parsePayoutStructure(STRUCTURE);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT structure is a different parse', () => {
    // The key is the string, so a changed row cannot serve a stale entry.
    parseBlindStructure(STRUCTURE);
    parseBlindStructure(JSON.stringify([{ level: 1, smallBlind: 1, bigBlind: 2 }]));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a malformed string is not re-attempted every second either', () => {
    for (let i = 0; i < 10; i++) parseBlindStructure('not json at all');
    expect(spy).toHaveBeenCalledTimes(1);
    // ...and still degrades exactly as before: a usable default, never a throw.
    expect(parseBlindStructure('not json at all')).toHaveLength(1);
    expect(parseLobby('not json at all')).toBeNull();
  });
});

describe('the cache cannot become a shared-mutable-state bug', () => {
  beforeEach(() => __clearParseJsonCache());

  it('hands each caller its own array', () => {
    // Returning the SAME array would make one caller's sort or push everybody
    // else's bug, at a distance and intermittently. The copy is 40 references;
    // the parse it replaces is the actual cost.
    const a = parseBlindStructure(STRUCTURE);
    const b = parseBlindStructure(STRUCTURE);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);

    a.length = 0;
    expect(parseBlindStructure(STRUCTURE)).toHaveLength(40);
  });

  it('is bounded, so a long session cannot grow it without limit', () => {
    for (let i = 0; i < 300; i++) parseJsonCached(JSON.stringify([{ level: i }]));
    expect(__parseJsonCacheSize()).toBeLessThanOrEqual(64);
  });

  it('returns undefined for an absent value rather than throwing', () => {
    expect(parseJsonCached(null)).toBeUndefined();
    expect(parseJsonCached(undefined)).toBeUndefined();
    expect(parseJsonCached('')).toBeUndefined();
  });
});

describe('the tables list can use React.memo again', () => {
  it('TableRow takes primitives, not the object rebuilt on every chip tick', async () => {
    // `lines` is derived from `entries`, so every chip update produced a fresh
    // object for EVERY row and memo's shallow compare failed on all of them: a
    // 200-table event re-rendered 200 rows to change nothing on 199.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(__dirname, '..', '..', 'src/components/tournament/details/TablesTab.tsx'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');

    expect(src).toMatch(/React\.memo\(function TableRow/);
    expect(src).toMatch(/\{\.\.\.line\}/);
    // The object prop is what defeated the memo; it must not come back.
    expect(src).not.toMatch(/<TableRow[\s\S]{0,200}line=\{line\}/);
  });
});
