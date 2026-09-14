/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - DIAMOND ARENA IS THE LIGHT ROOM, AND NOTHING ELSE IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-11: "ONLY DIFFERENCE BETWEEN THEM IS DIAMOND ARENA SHOULD BE
 * WHITE, OR LIGHT SCHEMA, CLUB ARENA DARK."
 *
 * `<html>` already carried two theme attributes that had to be prised apart
 * after they served the wrong palette on production for weeks: `data-theme`
 * is the player's interface mode and `data-color-theme` is the table felt.
 * The full postmortem is in tests/unit/settingsHaveOneOwner.test.ts and in
 * docs/changelog/2026-09-05-the-route-gate-could-not-fail-and-realism-becomes-
 * one-vocabulary.md, and its conclusion was that one attribute with two
 * meanings is decided by whichever writer ran last.
 *
 * This scheme is therefore a THIRD attribute rather than a fourth writer on an
 * existing one. It answers where the player IS; the other two answer what the
 * player PREFERS and what the felt looks like. This law holds those three
 * apart, holds the room's paint off the table, and holds the rule itself in
 * one place so it cannot drift the way the felt and the interface mode did.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceCssRule } from './helpers/sourceWindow';
import { ARENA_SCHEME_ATTR, ARENA_SCHEME_LIGHT, arenaSchemeFor } from '../src/lib/arenaScheme';

const at = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
/* Comments stripped before any assertion that is about CODE. Both of the
   assertions below were written against the raw file first and both went red
   on this file's own PROSE: the module explains at length why it does not
   touch `data-theme`, and the stylesheet's note quotes its own selector while
   explaining why that selector wins. That is the anchor-in-a-comment collision
   tests/helpers/sourceWindow.ts was written about, arriving from the other
   direction - here the comment does not move the window, it IS the match. */
const code = (p: string) =>
  at(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SHEET = 'src/styles/club-engine.css';
const RULE = 'src/lib/arenaScheme.ts';
const TOKENS = 'src/styles/design-tokens.css';

/* Held dark in every scheme by tests/seat-plates-stay-dark.law.test.ts. That
   law reads design-tokens.css, which is where the interface light block lives;
   this scheme is declared in the globally loaded sheet instead, so the same
   list has to be enforced here or the room's paint reaches the felt through a
   door that law cannot see. */
const TABLE_TOKENS = [
  '--seat-bg',
  '--seat-border',
  '--seat-text',
  '--felt-color',
  '--rail-highlight',
  '--timer-color',
  '--timer-glow',
];

describe('LAW - the room says where you are, not what you prefer', () => {
  it('the Diamond Arena is light, and the chip estate is not', () => {
    expect(arenaSchemeFor('/clubs/diamond-arena')).toBe(ARENA_SCHEME_LIGHT);
    expect(arenaSchemeFor('/clubs/002c2d27-9584-4e52-835a-bb2be148fc81/lobby')).toBe(
      ARENA_SCHEME_LIGHT
    );
    expect(arenaSchemeFor('/clubs/25450')).toBeNull();
    expect(arenaSchemeFor('/')).toBeNull();
    expect(arenaSchemeFor('/cashier')).toBeNull();
  });

  it('and the lobby opened as a TAB counts, because the URL does not move', () => {
    /* The in-table "+" opens a club lobby while the URL stays on /table/<id>.
       The club footer takes the same second input for the same reason; a route
       gate alone puts the chip estate's chrome around the Diamond lobby. */
    expect(arenaSchemeFor('/table/abc', 'diamond-arena')).toBe(ARENA_SCHEME_LIGHT);
    expect(arenaSchemeFor('/table/abc', '25450')).toBeNull();
    expect(arenaSchemeFor('/table/abc', null)).toBeNull();
  });

  it('one writer, and it is not the settings store or the felt', () => {
    const writers = [
      'src/stores/useSettingsStore.ts',
      'src/core/MasterBus.ts',
      'src/components/Shell.tsx',
      'src/hooks/useTableSettings.ts',
    ];
    for (const file of writers) {
      expect(code(file), `${file} writes the arena scheme`).not.toContain(ARENA_SCHEME_ATTR);
    }
    expect(code(RULE), 'the scheme module is the only writer').toContain(
      `setAttribute(ARENA_SCHEME_ATTR`
    );
  });

  it('and it never touches the attribute the player owns', () => {
    expect(code(RULE), 'the room must not rewrite a choice the player made').not.toMatch(
      /data-theme|setTheme/
    );
  });

  it('the scheme paints the room and not the table', () => {
    const rule = sliceCssRule(code(SHEET), "html[data-arena-scheme='light']");
    expect(rule, 'the scheme block is missing from the loaded sheet').toContain('--bg-primary');
    for (const token of TABLE_TOKENS) {
      expect(
        rule,
        `${token} is held dark in every scheme, and this block declares it`
      ).not.toContain(token);
    }
  });

  it('the two grounds are declared the same way, so neither can drift', () => {
    /* The dark estate paints the body `#000` under Dan's "SOLID BLACK AND ALL
       THE SAME COLOR". The light room paints the body from its own token
       rather than a second literal, so there is one place per room and the
       scheme block is the only thing that decides the answer. */
    const ground = sliceCssRule(code(SHEET), "html[data-arena-scheme='light'] body");
    expect(ground).toMatch(/background:\s*var\(--bg-primary\)/);
    expect(ground, 'a literal here is a second place to change the ground').not.toMatch(
      /#[0-9a-f]{3,8}/i
    );
  });

  it('the interface light mode is untouched and still answers to its own attribute', () => {
    /* The scheme is additive: a player who chose light in Settings keeps that
       everywhere, and this room is simply already light. If this block were
       ever merged into the interface one, the felt-versus-mode fight of
       2026-09-05 would start again with three names instead of two. */
    expect(code(TOKENS)).toContain("[data-theme='light']");
    expect(code(TOKENS), 'the room does not belong in the interface token sheet').not.toContain(
      ARENA_SCHEME_ATTR
    );
  });
});
