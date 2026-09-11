/**
 * WITHHOLDING THE ROW IS NOT WITHHOLDING THE QUERY (2026-09-11).
 *
 * The first pass at "played with diamonds, not chips" taught DynamicWallet to
 * withhold its club wallet ROWS in an arena that holds no chip wallet, and that
 * was read as done. It was not. The component still issued three chip reads on
 * mount and on all eight wallet bus events, still polled the chip jackpot pool
 * every ten seconds, and still ran the spins hook. The poll was the same read
 * that had just been removed from the lobby for timing out and 500ing on the
 * live arena, re-opened from the wallet a few lines away.
 *
 * These pins are on the source rather than a render, because what went wrong
 * was never visible in the output: the rows were correctly absent the whole
 * time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';

const wallet = readFileSync(
  join(__dirname, '..', '..', 'src/components/wallet/DynamicWallet.tsx'),
  'utf8'
);

describe('The wallet asks an arena no chip question', () => {
  it('gates the three chip reads, not merely the rows they feed', () => {
    const fetch = sliceStatement(wallet, 'const [profileRes, memberRes, agentRes, panelRes]');
    for (const read of ["from('club_members')", "from('agents')", "rpc('fn_club_money_panel'"]) {
      const at = fetch.indexOf(read);
      expect(at, `${read} is no longer inside the fetch`).toBeGreaterThan(-1);
      expect(
        fetch.slice(0, at).lastIndexOf('hasChipWallet'),
        `${read} is issued without checking hasChipWallet`
      ).toBeGreaterThan(-1);
    }
    expect(fetch).toContain("from('profiles')");
  });

  it('does not poll the chip jackpot pool in an arena', () => {
    const at = wallet.indexOf('watchBbjPool(resolvedId');
    expect(at).toBeGreaterThan(-1);
    const guard = wallet.lastIndexOf('!hasChipWallet', at);
    expect(guard, 'the jackpot poll lost its arena guard').toBeGreaterThan(-1);
  });

  it('does not run the spins wallet hook in an arena', () => {
    const call = sliceStatement(wallet, 'const spins = useSpinsWallet(');
    expect(call).toContain('hasChipWallet');
  });

  it('reads hasChipWallet before anything that depends on it', () => {
    const decl = wallet.indexOf('const hasChipWallet = useArenaHasChipWallet()');
    expect(decl).toBeGreaterThan(-1);
    expect(wallet.indexOf('const spins = useSpinsWallet(')).toBeGreaterThan(decl);
    expect(wallet.indexOf('watchBbjPool(resolvedId')).toBeGreaterThan(decl);
  });
});
