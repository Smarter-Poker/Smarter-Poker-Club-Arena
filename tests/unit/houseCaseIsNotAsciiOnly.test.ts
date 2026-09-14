/**
 * THE HOUSE TITLE CASE APPLIED TO ASCII AND CUT EVERYTHING ELSE UP
 *
 * Both halves of the house casing rule matched on ASCII classes. That is not a
 * rule that skips accented words politely - `titleCase` matched the ASCII RUN
 * INSIDE them and capitalised that, so the transform mangled its own input:
 *
 *     "événement du soir"  ->  "éVéNement Du Soir"
 *     "año nuevo"          ->  "AñO Nuevo"
 *     "ırmak kulübü"       ->  "ıRmak KulüBü"
 *
 * and `formatPopupText` skipped the first word entirely:
 *
 *     "über montag"        ->  "über Montag"
 *
 * Operators type club names, tournament names and custom ticker messages, and
 * every one of those strings goes through one of these two functions on the way
 * to a player. This is not a translation feature - nothing here is translated -
 * it is the house style failing on names the house already accepts.
 *
 * Recorded 2026-09-13, when a ticker pass went looking for an i18n gap and
 * found a live casing bug instead.
 */

import { describe, expect, it } from 'vitest';
import { formatPopupText } from '../../src/utils/popupStyle';
import { titleCase } from '../../src/utils/titleCase';
import { renderTickerItem, startingSoonItem } from '../../src/components/tournament/tickerMessages';

describe('titleCase no longer cuts a word at its first ASCII letter', () => {
  it('is the regression, verbatim', () => {
    expect(titleCase('événement du soir')).toBe('Événement Du Soir');
    expect(titleCase('año nuevo')).toBe('Año Nuevo');
    expect(titleCase('über montag')).toBe('Über Montag');
  });

  it('capitalises a word that begins with a dotless i', () => {
    /* U+0131 is not in [A-Za-z], so "ırmak" used to render "ıRmak". */
    expect(titleCase('ırmak kulübü')).toBe('Irmak Kulübü');
  });

  it('leaves every English behaviour exactly as it was', () => {
    expect(titleCase('sunday slam')).toBe('Sunday Slam');
    expect(titleCase('3rd of 128')).toBe('3rd Of 128');
    expect(titleCase('LIVE')).toBe('LIVE');
  });

  it('still shouts the acronyms, which a locale-aware fold would have broken', () => {
    /* "VIP".toLocaleLowerCase('tr') is "vıp", which is not in the acronym set.
       The lookup is deliberately invariant; only the display casing is not. */
    expect(titleCase('nlh')).toBe('NLH');
    expect(titleCase('vip')).toBe('VIP');
  });
});

describe('formatPopupText capitalises words in every script', () => {
  it('is the regression, verbatim', () => {
    expect(formatPopupText('über montag')).toBe('Über Montag');
    expect(formatPopupText('ırmak kulübü')).toBe('Irmak Kulübü');
    expect(formatPopupText('año nuevo')).toBe('Año Nuevo');
  });

  it('keeps the contraction rule this file was written to protect', () => {
    expect(formatPopupText("you're already seated at seat 3")).toBe(
      "You're Already Seated At Seat 3"
    );
    expect(formatPopupText("it's your turn")).toBe("It's Your Turn");
  });

  it('keeps the em dash rule', () => {
    expect(formatPopupText('a clause — and another')).toBe('A Clause. And Another');
    expect(formatPopupText('a–b')).toBe('A-B');
  });

  it('leaves every English behaviour exactly as it was', () => {
    expect(formatPopupText('sunday slam starts in 3:30')).toBe('Sunday Slam Starts In 3:30');
  });
});

describe('what this fix does NOT claim', () => {
  it('cannot case a Turkish name correctly for an English browser', () => {
    /* toLocaleUpperCase follows the RUNTIME locale, and the runtime here is
       whatever the test environment is. Getting "İzmir" for a Turkish club
       read by an English player needs the language OF THE TEXT, which nothing
       on this platform records. The honest guarantee is: right for the player
       whose own language it is, and never worse for anybody else. */
    const cased = formatPopupText('izmir turnuvası');
    expect(cased).toMatch(/^[Iİ]zmir Turnuvası$/);
  });
});

describe('and the whole rail pipeline, not just the transform', () => {
  /* The two functions above are shared utilities. What a player actually sees
     is a tournament name that has been through formatGameTitle AND
     formatPopupText on its way into a ticker item, so the guarantee is only
     real if it survives the composition. Fixing a helper and never checking
     its consumer is how the "Starts In0:19" defect shipped. */
  const NOW = 1_800_000_000_000;

  const named = (name: string) =>
    renderTickerItem(
      startingSoonItem({
        id: 't1',
        name,
        startsAt: NOW + 210_000,
        clubId: 'club-1',
        buyIn: 9,
        buyInFee: 2,
        registered: 24,
        isRegistered: false,
      }),
      NOW
    );

  it('carries an accented club name onto the bar intact', () => {
    expect(named('événement du soir')).toContain('Événement Du Soir');
    expect(named('événement du soir')).not.toContain('éVéNement');
  });

  it('capitalises a German name the rail used to leave lower case', () => {
    expect(named('über montag')).toContain('Über Montag');
  });

  it('still shouts the variant acronym beside a non-ASCII word', () => {
    /* formatGameTitle runs first and only uppercases known variants; every
       other token passes through untouched, which is what keeps it safe. */
    const line = named('über montag nlh');
    expect(line).toContain('NLH');
    expect(line).toContain('Über Montag');
  });
});
