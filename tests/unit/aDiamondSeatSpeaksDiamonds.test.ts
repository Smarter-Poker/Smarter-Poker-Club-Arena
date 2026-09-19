/**
 * A DIAMOND SEAT SPEAKS DIAMONDS.
 *
 * Dan 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA.
 * (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS AND ITS
 * PLAYED WITH DIAMONDS INSTEAD OF CHIPS)".
 *
 * The felt, the cashier and the top-up learned that. Every sentence a player
 * read on the way OUT of a seat had not: a Diamond player who sat out too long
 * was told "Your Chips Are Back In Your Wallet", a refused leave said "Your
 * Seat And Chips Stay On The Table", the reconnect warning promised their
 * chips were safe, the header's top-up button was titled "Add Chips", and the
 * seat-first sheet said "Not Enough Chips" beside a Diamond balance. None of
 * it was true at a Diamond seat, and all of it was sprinkled through one
 * 27,000-line page as bare literals.
 *
 * Two things are pinned. First, the copy module derives every one of those
 * sentences for both assets, and the chip sentences are BYTE-IDENTICAL to what
 * the page said before (a chip club must render exactly as it did). Second,
 * the page itself no longer carries a player-facing "Chips" anywhere a Diamond
 * seat can reach it: every remaining literal with the word sits inside a
 * branch that first asks the seat's asset.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode } from '../helpers/sourceWindow';
import {
  BOOT_REASONS,
  bootExplanation,
  seatCopy,
  seatUnits,
} from '../../src/components/table/seatExitCopy';

const read = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
/* Comments off, STRINGS KEPT: the literals are the subject here. */
const withoutComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TABLE_PAGE = 'src/pages/TablePage.tsx';
const TABLE_MENU = 'src/components/table/TableMenu.tsx';

/** What a chip seat said before 2026-09-19, verbatim. It must still say it. */
const CHIP_SENTENCES = {
  boot: {
    away_blind_cap:
      'You Were Away, So We Cashed You Out After One Small Blind And One Big Blind. Your Chips Are Back In Your Wallet.',
    sit_out_timeout:
      'You Sat Out Too Long And Were Cashed Out. Your Chips Are Back In Your Wallet.',
    abandoned_seat:
      'You Were Disconnected For Five Minutes, So Your Seat Was Cashed Out. Your Chips Are Back In Your Wallet.',
    busted_no_rebuy: 'You Ran Out Of Chips And Did Not Rebuy, So Your Seat Was Released.',
    nit_game_vpip:
      'This Table Has A Minimum VPIP And You Were Below It, So You Were Cashed Out. Your Chips Are Back In Your Wallet.',
  },
  removedFromTable: 'You Were Removed From The Table. Your Chips Are Back In Your Wallet.',
  seatStaysTapToReturn: 'Your Seat And Chips Stay On The Table, Tap Its Tab To Return.',
  seatStaysTapToReturnAndCashOut:
    'Your Seat And Chips Stay On The Table, Tap Its Tab To Return And Cash Out.',
  couldNotCashOutYet:
    'Could Not Cash Out Yet. Your Seat And Chips Stay On The Table, Tap Its Tab To Return.',
  reconnectingSeated: 'Still reconnecting. Your seat and chips are safe on the server.',
  addFunds: 'Add Chips',
  takingYourFunds: 'Taking Your Chips',
  notEnoughFunds: 'Not Enough Chips',
  stillFillingSeatIsSafe: 'Still Filling Your Game, Your Seat And Chips Are Safe',
} as const;

describe('the copy module derives every exit sentence for both assets', () => {
  it('a chip seat, and a seat whose asset has not landed, read exactly what they read before', () => {
    for (const asset of ['chips', null, undefined] as const) {
      expect(seatUnits(asset)).toBe('Chips');
      const copy = seatCopy(asset);
      for (const [key, sentence] of Object.entries(CHIP_SENTENCES)) {
        if (key === 'boot') continue;
        expect(copy[key as keyof typeof copy], `${key} for ${String(asset)}`).toBe(sentence);
      }
      for (const reason of BOOT_REASONS) {
        expect(bootExplanation(reason, asset), `${reason} for ${String(asset)}`).toBe(
          CHIP_SENTENCES.boot[reason]
        );
      }
    }
  });

  it('a Diamond seat says Diamonds in every one of them, and Chips in none', () => {
    expect(seatUnits('diamonds')).toBe('Diamonds');
    const copy = seatCopy('diamonds');
    const sentences: string[] = [
      ...Object.values(copy),
      ...BOOT_REASONS.map((reason) => bootExplanation(reason, 'diamonds') ?? ''),
    ];
    expect(sentences).toHaveLength(Object.keys(CHIP_SENTENCES).length - 1 + BOOT_REASONS.length);
    for (const sentence of sentences) {
      expect(sentence, 'every sentence is derived').not.toBe('');
      expect(sentence, sentence).toMatch(/Diamonds/i);
      expect(sentence, sentence).not.toMatch(/chips/i);
    }
  });

  it('the Diamond sentence is the chip sentence with one word changed', () => {
    /* Not a wording rule for its own sake: it is what makes "byte-identical for
       chips" and "true for Diamonds" the SAME template, so the two cannot drift
       apart one sentence at a time. */
    const chip = seatCopy('chips');
    const diamond = seatCopy('diamonds');
    for (const key of Object.keys(chip) as Array<keyof typeof chip>) {
      expect(diamond[key]).toBe(
        chip[key].replace(/Chips/g, 'Diamonds').replace(/chips/g, 'diamonds')
      );
    }
    for (const reason of BOOT_REASONS) {
      expect(bootExplanation(reason, 'diamonds')).toBe(
        bootExplanation(reason, 'chips')!.replace(/Chips/g, 'Diamonds')
      );
    }
  });

  it('an unmapped eviction reason has no sentence, so the caller decides', () => {
    expect(bootExplanation('balancer_move', 'chips')).toBeUndefined();
    expect(bootExplanation(undefined, 'diamonds')).toBeUndefined();
  });

  it('every sentence is Title Case with no em dash, except the one the Toast layer cases', () => {
    for (const asset of ['chips', 'diamonds'] as const) {
      const copy = seatCopy(asset);
      const all = [
        ...Object.entries(copy).map(([k, v]) => [k, v] as const),
        ...BOOT_REASONS.map((r) => [r, bootExplanation(r, asset)!] as const),
      ];
      for (const [key, sentence] of all) {
        expect(sentence, key).not.toContain(String.fromCharCode(0x2014));
        if (key === 'reconnectingSeated') continue;
        for (const word of sentence.split(/\s+/)) {
          expect(word, `${key}: "${word}"`).toMatch(/^[A-Z0-9$(]/);
        }
      }
    }
  });
});

/**
 * THE SOURCE PIN. Each string or template literal in the table page that
 * contains the word "Chip" or "Chips" is located in code (comments off), and
 * the expression it sits in is read out to the brackets or statement that
 * enclose it, exactly as tests/helpers/sourceWindow.ts prescribes: the window
 * grows with the code, never with a byte count. That expression must first
 * ask whether the seat is a Diamond seat. A bare "Chips" a Diamond seat can
 * reach is the regression this file exists to stop.
 */
function chipLiteralWindows(src: string): string[] {
  const code = withoutComments(src);
  const blanked = blankNonCode(code);
  const windows: string[] = [];
  const literal = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
  for (const m of code.matchAll(literal)) {
    if (!/\bChips?\b/.test(m[0])) continue;
    /* Backwards to the statement or bracket that encloses the literal. */
    const at = m.index ?? 0;
    let depth = 0;
    let start = at;
    for (let i = at - 1; i >= 0; i--) {
      const c = blanked[i];
      if (c === ')' || c === '}' || c === ']') depth++;
      else if (c === '(' || c === '{' || c === '[') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      } else if (c === ';' && depth === 0) {
        start = i + 1;
        break;
      }
      start = i;
    }
    /* Forwards to the matching close or the end of the statement. */
    depth = 0;
    let end = code.length;
    for (let i = at + m[0].length; i < blanked.length; i++) {
      const c = blanked[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      } else if (c === ';' && depth === 0) {
        end = i;
        break;
      }
    }
    windows.push(code.slice(start, end));
  }
  return windows;
}

describe('the table page carries no bare Chips a Diamond seat can reach', () => {
  const page = read(TABLE_PAGE);

  it('every exit sentence is read from the copy module, keyed by the seat asset', () => {
    const code = withoutComments(page);
    expect(code).toMatch(
      /import \{ bootExplanation, seatCopy \} from '\.\.\/components\/table\/seatExitCopy'/
    );
    expect(code).toMatch(/bootExplanation\(reason, seatAsset\)/);
    expect(code).toMatch(/seatCopy\(seatAsset\)\.removedFromTable/);
    expect(code).toMatch(/seatCopy\(tableState\.arenaAsset\)\.seatStaysTapToReturn\}/);
    expect(
      code.match(/seatCopy\(tableState\.arenaAsset\)\.seatStaysTapToReturnAndCashOut/g)
    ).toHaveLength(2);
    expect(code).toMatch(
      /goToLobbyKeepingSeat\(seatCopy\(tableState\.arenaAsset\)\.couldNotCashOutYet\)/
    );
    expect(code).toMatch(/seatCopy\(tableStateRef\.current\.arenaAsset\)\.reconnectingSeated/);
    expect(code).toMatch(/title=\{seatCopy\(tableState\.arenaAsset\)\.addFunds\}/);
    expect(code).toMatch(/seatCopy\(tableState\.arenaAsset\)\.takingYourFunds/);
    expect(code).toMatch(/seatCopy\(tableState\.arenaAsset\)\.notEnoughFunds/);
    expect(code).toMatch(/seatCopy\(tableState\.arenaAsset\)\.stillFillingSeatIsSafe/);
  });

  it('every literal that still says Chips sits in a branch that asked the seat asset first', () => {
    const windows = chipLiteralWindows(page);
    /* Two remain and both are legitimate: the top-up units line and the
       automatic top-up receipt, each a ternary on the asset. A third is a new
       sentence somebody wrote in chips; it belongs in seatExitCopy. */
    expect(windows.length, windows.join('\n---\n')).toBe(2);
    for (const window of windows) {
      expect(window, window).toMatch(/=== 'diamonds'\s*\?/);
      expect(window, window).toMatch(/Diamonds?\b/);
    }
  });

  it('the boot toast asks the ref, because the callback is registered once', () => {
    /* `applySeatRemoved` is memoised on `userId` alone; a closure over
       `tableState` would name the asset of the FIRST render, which is
       undefined, and a Diamond seat would be told about chips after all. */
    expect(withoutComments(page)).toMatch(
      /const seatAsset = tableStateRef\.current\.arenaAsset;\s*const mapped = bootExplanation\(reason, seatAsset\)/
    );
  });
});

describe('the tab bar menu carries no denomination at all', () => {
  it('names neither Chips nor Diamonds in code', () => {
    expect(withoutComments(read(TABLE_MENU))).not.toMatch(/\b(Chips?|Diamonds?)\b/);
  });
});
