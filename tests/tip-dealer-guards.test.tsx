/**
 * DEALER TIPPING STAYS REMOVED
 * ============================================================================
 * This file used to render `src/components/table/TipDealer` and assert its
 * validation. That component was deleted on 2026-08-20 by product decision -
 * Smarter Poker has no dealers to tip - and the test was written afterwards,
 * so it could never resolve its own import. It failed at transform time from
 * the moment it landed, and because the client suite gates the World Hub
 * bundle, NOTHING shipped to production for as long as it sat on main.
 *
 * The intent behind it is still worth keeping, and is stronger stated the
 * other way round. The old path was not merely dead, it was dangerous: it
 * called deduct_table_chip_lock from the browser, writing table_seats.stack
 * while the authoritative engine held a different figure in memory. The next
 * settlement overwrote the row from memory, so the player got their stack back
 * while clubs.chip_treasury kept the tip - it MINTED chips. See the note in
 * WalletService.
 *
 * So this now guards the REMOVAL: no component, no re-export, no client-side
 * caller. A file that cannot be imported guards nothing; a rule about what
 * must not come back guards something real.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(__dirname, '../src');

/** Code only. A rule that fires on its own documentation gets deleted. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('dealer tipping stays removed', () => {
  it('no tipping component exists', () => {
    // TipDealer was the in-game modal. TipPrompt was a second one, in
    // components/feedback, offering to tip "the dealer" after a win - dead,
    // exported from the feedback barrel, and never rendered. Dan, 2026-08-21:
    // "REMOVE ANY AND ALL THINGS RELATED TO TIPPING DEALERS."
    const gone = [
      ['components/table', 'TipDealer'],
      ['components/feedback', 'TipPrompt'],
    ];
    const found: string[] = [];
    for (const [dir, name] of gone) {
      for (const ext of ['.tsx', '.ts', '.jsx', '.js', '.css']) {
        if (existsSync(join(SRC, dir, `${name}${ext}`))) found.push(`${dir}/${name}${ext}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('nothing imports or re-exports either of them', () => {
    const offenders = walk(SRC).filter((f) => {
      // Barrel files carry comments explaining the removal, which are the one
      // kind of mention that should survive. Match code, not prose.
      const text = stripComments(readFileSync(f, 'utf8'));
      return (
        /\bfrom\s+['"][^'"]*(TipDealer|TipPrompt)['"]/.test(text) ||
        /\b(TipDealer|TipPrompt)\s*[,}]/.test(text)
      );
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('the server has no tipdealer route or handler', () => {
    const SERVER = resolve(__dirname, '../server/src');
    expect(existsSync(join(SERVER, 'handlers/tipdealer.ts'))).toBe(false);
    if (!existsSync(SERVER)) return;
    const offenders = walk(SERVER).filter((f) =>
      /tipDealer|handleTipdealer|['"]\/tipdealer['"]/.test(stripComments(readFileSync(f, 'utf8')))
    );
    expect(offenders.map((f) => relative(SERVER, f))).toEqual([]);
  });

  it('no client-side dealer tip call survives', () => {
    // processDealerTip, GameServerAPI.tipDealer and the POST /tipdealer route
    // all went with it. Any of them reappearing means the chip-minting path is
    // back, because the browser has no authority over a seated stack.
    //
    // Comments are stripped first. WalletService carries a long note naming
    // every removed symbol precisely so nobody rebuilds them from memory, and
    // a guard that fires on its own documentation is a guard that gets deleted.
    const banned =
      /processDealerTip|tipDealer\s*\(|['"]\/tipdealer['"]|atomic_table_dealer_tip|deduct_table_chip_lock/;
    const offenders = walk(SRC).filter((f) => banned.test(stripComments(readFileSync(f, 'utf8'))));
    expect(
      offenders.map((f) => relative(SRC, f)),
      'Dealer tipping wrote table_seats.stack from the browser while the engine ' +
        'held a different figure in memory, and the next settlement handed the ' +
        'stack back while the treasury kept the tip. It minted chips.'
    ).toEqual([]);
  });
});
