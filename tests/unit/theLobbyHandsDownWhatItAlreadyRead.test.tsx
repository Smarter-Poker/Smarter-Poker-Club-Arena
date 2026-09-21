/**
 * THE LOBBY HANDS DOWN WHAT IT ALREADY READ (2026-09-21)
 *
 * Two defects on `/tournaments`, one read:
 *
 * 1. The page reads every one of this player's registrations in ONE query and
 *    then did not pass the answer to the cards, so each card ran its own
 *    `tournament_players` lookup on mount. On a 72-hour board that is twenty
 *    to forty extra round trips per load. TournamentLobbyCard's own header has
 *    documented the fix since 2026-08-25; the lobby was never wired to it.
 *
 * 2. `regData?.map(...) || []` folded a FAILED read into an empty list, and an
 *    empty list reads as "registered for nothing" - so a player who was
 *    already in was shown a live "Register (buy-in)" button, and pressing it
 *    is a second entry attempt against real money. A read that did not answer
 *    is its own outcome (10.86 rule 1) and is carried as `null`, which is what
 *    the card's `knownRegistration` contract means by "go and look yourself".
 *
 * This reads the page's source rather than mounting it: the page owns six
 * queries and a realtime channel, and the pin here is the wiring, which is
 * what regressed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Source with its comments removed, so a rule quoting the old shape in prose
 *  (as the ones below do) cannot satisfy or break a pin about the code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const page = readFileSync(
  join(__dirname, '../../src/pages/tournament/TournamentLobbyPage.tsx'),
  'utf8'
);
const card = readFileSync(
  join(__dirname, '../../src/components/tournament/TournamentLobbyCard.tsx'),
  'utf8'
);

describe('the tournament lobby hands its cards the answer it already has', () => {
  it('passes knownRegistration rather than letting every card ask again', () => {
    expect(page).toMatch(/knownRegistration=\{tournament\.isRegistered\}/);
  });

  it('keeps "the read did not answer" as its own outcome, never as false', () => {
    // The batch list is nullable, and null survives into the view model.
    expect(page).toMatch(/let registrations: string\[\] \| null/);
    expect(page).toMatch(/registrations === null \? null : registrations\.includes/);
    expect(page).toMatch(/isRegistered: boolean \| null/);
    // A failed read is reported, not swallowed.
    expect(page).toMatch(/regError/);
    // And the old coercion is gone from the CODE (the prose above quotes it).
    expect(code(page)).not.toMatch(/regData\?\.map\([^)]*\)\s*\|\|\s*\[\]/);
  });

  it('the card still honours null as "look it up yourself"', () => {
    // Only a real boolean short-circuits the card's own lookup.
    expect(card).toMatch(/typeof knownRegistration === 'boolean'/);
  });

  it('the lobby reads the one column the Spin rule needs', () => {
    expect(page).toMatch(/spin_multiplier/);
    expect(page).toMatch(/spin_multiplier: tournament\.spinMultiplier/);
    /* A PostgREST column list is sent verbatim: a block comment written inside
       those backticks becomes part of the query. It cost a red typecheck once. */
    const fields = page.slice(page.indexOf('const fields = `'));
    expect(fields.slice(0, fields.indexOf('`;'))).not.toMatch(/\/\*/);
  });
});
