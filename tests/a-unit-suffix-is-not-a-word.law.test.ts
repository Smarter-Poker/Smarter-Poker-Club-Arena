/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A UNIT SUFFIX IS NOT A WORD (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * check-title-case capitalises the first letter of every word. A letter sitting
 * immediately after a digit is not the first letter of a word - it is the tail
 * of the token the digits started:
 *
 *     Last 24h        ->  Last 24H
 *     Win 1.5x        ->  Win 1.5X
 *     Won 20bb+ Pots  ->  Won 20BB+ Pots
 *     GPT-4o Mini     ->  GPT-4O Mini
 *
 * WHY THIS IS WORSE THAN A COSMETIC BUG. The gate is also the fixer. Once
 * --fix writes "24H", the gate DEMANDS "24H" from then on: the corruption is
 * what passes CI, and the correct copy is what fails it. A rule that enforces
 * its own mistake does not get noticed by review.
 *
 * FOUND by running this gate against the apex site on 2026-08-31, where the
 * same logic wanted to rewrite "Last 24h" and "GPT-4o Mini" on live admin
 * pages. The World Hub copy already carried the guard; Club Arena's did not,
 * and its own attempt at one - `if (/^[0-9]/.test(word))` - can never fire,
 * because the match expression begins at [A-Za-z] so `word` never starts with
 * a digit.
 *
 * Nothing in Club Arena's copy hits this today. That is what makes it worth
 * pinning rather than leaving: it is a trap set for whoever next writes the
 * word "24h" on a page.
 */
import { describe, it, expect } from 'vitest';
import { titleCaseText } from '../scripts/ci/check-title-case.mjs';

describe('a letter after a digit is left alone', () => {
  it.each([
    ['Last 24h', 'time windows'],
    ['Win 1.5x Your Buy In', 'multipliers'],
    ['Won 20bb+ Pots', 'big blind counts'],
    ['GPT-4o Mini', 'product names'],
    ['Every 30s', 'second intervals'],
    ['Signups (7d)', 'day windows'],
    ['Services Return 2xx', 'status code classes'],
  ])('%s is unchanged (%s)', (input) => {
    expect(titleCaseText(input)).toBe(input);
  });
});

describe('the rule it exists to enforce still works', () => {
  it('capitalises the first letter of every ordinary word', () => {
    expect(titleCaseText('claim your seat now')).toBe('Claim Your Seat Now');
    expect(titleCaseText('add-on and win/loss')).toBe('Add-On And Win/Loss');
  });

  it('still shouts the acronyms', () => {
    expect(titleCaseText('vip table')).toBe('VIP Table');
    expect(titleCaseText('bbj payout')).toBe('BBJ Payout');
  });

  it('leaves interior capitals and existing shouting alone', () => {
    expect(titleCaseText('PokerStars LIVE')).toBe('PokerStars LIVE');
  });

  it('does not touch an HTML entity', () => {
    expect(titleCaseText('a&nbsp;b')).toBe('A&nbsp;B');
  });
});
