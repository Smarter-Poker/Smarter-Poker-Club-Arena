/**
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER.
 *
 * Dan, 2026-09-13, twice in one hour, after I proposed an "arena chips" plate
 * and a diamonds-to-chips conversion flow for the wallet: "NO ARENA CHIPS,
 * DIAMOND ARENA IS DIAMONDS ONLY NO CHIPS EVER."
 *
 * The database already refuses it at the root (poker_arena_membership_guard,
 * 20260908152855: a diamonds-club membership with any chip balance raises
 * "Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy").
 * This law keeps the WALLET from ever drawing one: the summary read, the
 * ledger labels and the wallet page carry no chip figure for the arena, and
 * the guard that makes it impossible stays in the migrations.
 *
 * Measured 2026-09-13 before this law: the arena club had 0 members with a
 * chip balance, 0 chip_ledger rows, 0 chip stacks across its 17 tables.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { blankNonCode } from './helpers/sourceWindow';
import { arenaAssetUnitCents, arenaAssetUnitCentsIfRead } from '../src/lib/arenaUnitCents';
import {
  CHIP_UNIT_CENTS,
  DIAMOND_UNIT_CENTS,
  UNIT_CENTS_ASSET_NOT_READ,
} from '../server/src/tournament/tournamentUnit';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the Diamond Arena is diamonds only', () => {
  it('the summary read reports diamonds and no chip figure', () => {
    const service = read('src/services/DiamondService.ts');
    const summary = service.slice(
      service.indexOf('export interface DiamondArenaInfo'),
      service.indexOf('export interface DiamondLifetimeStats')
    );
    expect(summary.length).toBeGreaterThan(100);
    expect(summary).not.toMatch(/chip/i);
    expect(summary).toContain('inArena: number;');
    expect(summary).toContain('cashGamesEnabled: boolean;');
  });

  it('the summary RPC reads custody and the arena flags, never a chip balance', () => {
    const migration = read(
      'supabase/migrations/20260914015457_the_wallet_learns_the_diamond_arena.sql'
    );
    const body = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary'),
      migration.indexOf('COMMENT ON FUNCTION public.fn_diamond_wallet_summary')
    );
    expect(body).toContain('FROM public.poker_diamond_custody');
    expect(body).toContain("c.asset = 'diamonds'");
    expect(body).not.toMatch(/chip_balance|club_members|chip_ledger/);
    // Own-user only: a player cannot read another player's figures.
    expect(body).toContain("RAISE EXCEPTION 'wallet_summary_is_own_only'");
  });

  it('the arena ledger kinds are labelled as diamonds, not chips', () => {
    const modal = read('src/components/wallet/DiamondWalletModal.tsx');
    expect(modal).toMatch(/arena_deposit: \{[^}]*label: 'Diamond Arena Buy-In'/);
    expect(modal).toMatch(/arena_withdraw: \{[^}]*label: 'Diamond Arena Cash-Out'/);
    // The ENTRY lines, not the comment above them that explains the rule.
    const arenaLines = modal.split('\n').filter((l) => /^\s+arena_(deposit|withdraw):/.test(l));
    expect(arenaLines).toHaveLength(2);
    for (const line of arenaLines) expect(line).not.toMatch(/chip/i);
  });

  it('no wallet surface pairs the arena with chips', () => {
    const files = [
      'src/pages/PlayerWalletPage.tsx',
      'src/services/DiamondService.ts',
      'src/hooks/useDiamondLedger.ts',
      'src/components/wallet/DiamondWalletModal.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      // "arena chips", "chips for the arena", "convert ... to chips": none of it.
      expect(src, f).not.toMatch(/arena[ _-]?chips?/i);
      expect(src, f).not.toMatch(/chips? (for|in|at|into) the (diamond )?arena/i);
      expect(src, f).not.toMatch(/diamonds? (to|into) (arena )?chips/i);
    }
  });

  it('where the diamonds go buckets the arena as diamonds and the panel has no chip vocabulary (phase 5)', () => {
    /* The LIVE map is the latest redefinition of fn_diamond_kind_bucket
       (20260914110559 first draft, 20260914114052 every writer, 20260920141527
       the Diamond Games, 20260920141807 the Diamond Spins perks). Pin the
       version production runs. */
    const migration = read(
      'supabase/migrations/20260920141807_the_diamond_kind_map_names_the_spins_perks.sql'
    );
    const map = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket'),
      migration.indexOf('COMMENT ON FUNCTION public.fn_diamond_kind_bucket')
    );
    expect(map.length).toBeGreaterThan(100);
    // The arena kinds have their own buckets, named as diamonds.
    expect(map).toMatch(/k IN \('arena_deposit', 'tournament_fee'\)\s+THEN 'arena'/);
    expect(map).toMatch(/k IN \('arena_withdraw', 'arena'\)\s+THEN 'arena_cash_outs'/);
    expect(map).toMatch(/WHEN 'arena'\s+THEN 'Diamond Arena Seats'/);
    expect(map).toMatch(/WHEN 'arena_cash_outs'\s+THEN 'Diamond Arena Cash-Outs'/);
    // Nothing that says "arena" ever lands in the club-chips bucket, and the
    // only chip bucket is a member-club purchase, named so.
    const chipLines = map.split('\n').filter((l) => /THEN 'club_chips'/.test(l));
    expect(chipLines.length).toBeGreaterThan(0);
    for (const line of chipLines) {
      expect(line).not.toMatch(/arena/i);
    }
    expect(map).toMatch(/WHEN 'club_chips'\s+THEN 'Club Chip Purchases'/);
    // Every label a player reads: Title Case words, no em dash.
    for (const [, label] of map.matchAll(/THEN '([A-Z][^']*)'/g)) {
      expect(label).not.toContain('\u2014');
      for (const word of label.split(/[\s-]+/)) {
        if (word) expect(word[0], `${label}: ${word}`).toMatch(/[A-Z]/);
      }
    }
    // The panel prints diamonds and nothing else.
    const panel = read('src/components/wallet/DiamondFlowPanel.tsx');
    const math = read('src/components/wallet/diamondFlowMath.ts');
    for (const [name, src] of [
      ['DiamondFlowPanel', panel],
      ['diamondFlowMath', math],
    ] as const) {
      const code = src.slice(src.indexOf('import '));
      expect(code, name).not.toMatch(/chip/i);
    }
    expect(panel).toContain('{fmt(total)} Diamonds');
  });

  it('the database guard that refuses a chip wallet on the diamonds club is still in the migrations', () => {
    const dir = resolve(process.cwd(), 'supabase/migrations');
    const carriers = readdirSync(dir).filter((f) =>
      readFileSync(resolve(dir, f), 'utf8').includes(
        'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy'
      )
    );
    expect(carriers).toContain('20260908152822_poker_arena_identity_and_access.sql');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NOR IS A DIAMOND BOUNTY, PRIZE OR KNOCKOUT EVER PRINTED AS CHIPS (2026-09-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 made the database and the engine run flat bounty, PKO and mystery
 * bounty events in whole Diamonds. #4954 moved the ladder, the chest ladder,
 * the celebration, the ranking card, the session summary and the results page
 * onto the event's unit. This pass found the rest still speaking chips:
 *
 *   - the winner's prize counted up through the chip contract, so a Diamond
 *     prize climbed through "17.45" and landed on a figure with no noun;
 *   - the final table printed "<pool> Chips" after every pool;
 *   - the mystery chest revealed a bare figure;
 *   - the tournament page printed "<head> Chips" and "<head> Chips Starting
 *     Bounty", the detail tab's podium "<prize> Chips", and the Sign Up card
 *     "<head> Chips" - and the card read, printed and gated on a CHIP wallet,
 *     because `fn_player_spendable_balance` falls back to the player's home
 *     chip club when the arena has no member row.
 *
 * Nothing was ever shown wrongly to a player: `tournaments_enabled` is false
 * and no Diamond tournament has run. This is the gap closing before the
 * switch, and these pins are what keep a future bounty surface from reopening
 * it. The two shapes every one of those defects took are banned outright on
 * every tournament surface, so a new surface cannot regress to the chip
 * formatter without this file going red and saying what to use instead.
 *
 * A TOURNAMENT SURFACE is any source file whose path names a tournament, a
 * bounty, a mystery or a knockout, plus the hosts below that print tournament
 * money from outside those folders. A new surface that prints a bounty or a
 * prize from somewhere else belongs in HOSTS.
 */
describe('a Diamond bounty, prize or knockout is never printed as chips', () => {
  const HOSTS = [
    'src/pages/TablePage.tsx',
    'src/components/table/TableModalsLayer.tsx',
    'src/components/table/SeatSlot.tsx',
    'src/components/session/SessionSummaryHost.tsx',
  ];

  /** Every non-test .ts/.tsx under a directory, repo-relative. */
  const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(rel));
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
    }
    return out;
  };

  const SURFACES = sourceFiles('src').filter(
    (f) => /tournament|bounty|mystery|knockout/i.test(f) || HOSTS.includes(f)
  );

  /**
   * Comments removed, strings KEPT: the chip noun lives in JSX text and in
   * template literals, which is exactly what `blankNonCode` would erase. Line
   * breaks survive so an offender can be reported by line.
   */
  const withoutComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');

  /** Tournament money, by the words every such figure in this estate is named with. */
  const MONEY_WORD = /bounty|prize|payout|knockout|winnings|award/i;

  /**
   * SHAPE ONE: a money figure followed by the literal chip noun, in JSX
   * (`{money(head)} Chips`) or in a template (`${chipsCompact(prize)} Chips`).
   */
  const CHIP_NOUN = /\{[^{}]*(?:bounty|prize|payout|knockout|winnings|award)[^{}]*\}\s*Chips\b/gi;

  /**
   * SHAPE TWO: a money figure handed straight to a formatter that keeps two
   * places for a fraction. At the chip unit each of these is right, and each is
   * reached through the unit-aware family, which IS the chip contract there:
   * `formatPrizeAtUnit(x, 1)` returns `formatTableChips(x)`, and
   * `formatAwardAtUnit(x, 1)` returns `formatChipAward(x)`.
   */
  const CHIP_CONTRACT = /\b(formatTableChips|formatChipAward|formatStackChips|formatChips)\(/g;

  const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

  it('knows which files are tournament surfaces, and they are the ones that print this money', () => {
    // The floor. A rename must not turn the censuses below into a clean bill
    // of health over nothing at all (CLAUDE.md 10.86 rule 1).
    for (const surface of [
      'src/components/table/TournamentWinnerOverlay.tsx',
      'src/components/tournament/FinalTableOverlay.tsx',
      'src/components/tournament/MysteryBountyChest.tsx',
      'src/components/tournament/MysteryBountyCelebration.tsx',
      'src/components/tournament/MysteryBountyPanel.tsx',
      'src/components/tournament/TournamentRankingCard.tsx',
      'src/components/tournament/signUpDialog.tsx',
      'src/components/tournament/details/DetailOverviewTab.tsx',
      'src/components/tournament/details/RewardsTab.tsx',
      'src/pages/TournamentPage.tsx',
      'src/pages/tournament/TournamentResultsPage.tsx',
      'src/services/MysteryBountyService.ts',
      ...HOSTS,
    ]) {
      expect(SURFACES, `${surface} is no longer a tournament surface to this law`).toContain(
        surface
      );
    }
  });

  it('the detectors still catch the exact shapes this pass removed', () => {
    const caught = [
      '{money(selectedTournament.bounty_amount)} Chips',
      '{money(selectedTournament.bounty_amount)} Chips Starting Bounty',
      '{money(o.bountyAmount || 0)} Chips',
      '{compactChips(prizePool)} Chips',
      '`${chipsCompact(prizeValue)} Chips`',
    ];
    for (const shape of caught) {
      expect(
        shape.match(CHIP_NOUN),
        `the chip-noun detector no longer sees: ${shape}`
      ).not.toBeNull();
    }
    expect('Prize: {formatTableChips(displayPrize)}'.match(CHIP_CONTRACT)).not.toBeNull();
    // And the forms that replaced them are clean, or the census would be red forever.
    for (const fixed of [
      '{selectedHeadFigure} {moneyWordAtUnit(selectedUnitCents)}',
      '{headText}',
      '`${formatPrizeAtUnit(n, unitCents)}${moneySuffixAtUnit(unitCents)}`',
    ]) {
      expect(fixed.match(CHIP_NOUN), fixed).toBeNull();
      expect(fixed.match(CHIP_CONTRACT), fixed).toBeNull();
    }
  });

  it('no tournament surface glues the chip noun onto a bounty, prize or knockout figure', () => {
    const offenders: string[] = [];
    for (const file of SURFACES) {
      const src = withoutComments(read(file));
      for (const m of src.matchAll(CHIP_NOUN)) {
        offenders.push(`${file}:${lineOf(src, m.index ?? 0)}  ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(
      offenders,
      `These print a tournament money figure followed by the word "Chips":\n\n  ${offenders.join(
        '\n  '
      )}\n\nAt a Diamond event that is a Diamond bounty, prize or knockout wearing the chip noun. ` +
        `Print the word with moneyWordAtUnit(unitCents) (or moneySuffixAtUnit where a chip figure ` +
        `never had one), with the unit read off the event: tournamentRowUnitCents(row) where the ` +
        `arena embed is in hand, arenaAssetUnitCentsIfRead(arenaAsset) at a table.`
    ).toEqual([]);
  });

  it('no tournament surface hands a bounty, prize or award straight to the chip contract', () => {
    const offenders: string[] = [];
    for (const file of SURFACES) {
      const raw = read(file);
      const code = blankNonCode(raw);
      for (const m of code.matchAll(CHIP_CONTRACT)) {
        const at = (m.index ?? 0) + m[0].length - 1;
        // The argument, bounded by its own closing paren rather than by a count.
        let depth = 0;
        let end = at;
        for (; end < code.length; end++) {
          if (code[end] === '(') depth++;
          else if (code[end] === ')' && --depth === 0) break;
        }
        const argument = raw.slice(at + 1, end);
        if (MONEY_WORD.test(argument)) {
          offenders.push(`${file}:${lineOf(raw, m.index ?? 0)}  ${m[1]}(${argument})`);
        }
      }
    }
    expect(
      offenders,
      `These print a tournament money figure through the chip contract:\n\n  ${offenders.join(
        '\n  '
      )}\n\nThat contract keeps two places for a fraction, so a Diamond figure is printed on the ` +
        `cent grid. Use formatPrizeAtUnit(amount, unitCents) or formatAwardAtUnit(amount, ` +
        `unitCents): at the chip unit each of them IS the chip formatter, so a chip event prints ` +
        `exactly what it did.`
    ).toEqual([]);
  });

  it('a surface that prints a prize at a moment of its own waits for an unread arena', () => {
    // The seat badge and the knockout float keep the named cent for an unread
    // arena. The prize, the chest and the pool must not: until the table has
    // been read they have no unit, and they say so by printing nothing.
    expect(arenaAssetUnitCents(undefined)).toBe(UNIT_CENTS_ASSET_NOT_READ);
    expect(arenaAssetUnitCentsIfRead(undefined)).toBeNull();
    expect(arenaAssetUnitCentsIfRead(null)).toBeNull();
    expect(arenaAssetUnitCentsIfRead('chips')).toBe(CHIP_UNIT_CENTS);
    expect(arenaAssetUnitCentsIfRead('diamonds')).toBe(DIAMOND_UNIT_CENTS);

    const layer = blankNonCode(read('src/components/table/TableModalsLayer.tsx'));
    expect(layer).toContain(
      'const tournamentPrizeUnitCents = arenaAssetUnitCentsIfRead(arenaAsset);'
    );
    for (const overlay of ['<FinalTableOverlay', '<TournamentWinnerOverlay']) {
      const at = layer.indexOf(overlay);
      expect(at, `${overlay} is no longer rendered by the table's modal layer`).toBeGreaterThan(-1);
      const element = layer.slice(at, layer.indexOf('/>', at));
      expect(element, `${overlay} must take the table's read-or-null unit`).toContain(
        'unitCents={tournamentPrizeUnitCents}'
      );
    }
    const table = blankNonCode(read('src/pages/TablePage.tsx'));
    const chest = table.slice(table.indexOf('<MysteryBountyChest'));
    expect(chest.slice(0, chest.indexOf('/>'))).toContain(
      'unitCents={arenaAssetUnitCentsIfRead(tableState.arenaAsset)}'
    );

    for (const file of [
      'src/components/table/TournamentWinnerOverlay.tsx',
      'src/components/tournament/FinalTableOverlay.tsx',
      'src/components/tournament/MysteryBountyChest.tsx',
    ]) {
      const code = blankNonCode(read(file));
      expect(code, `${file} must require its unit and accept "not read"`).toMatch(
        /\bunitCents: number \| null;/
      );
      expect(code, `${file} must print nothing for an unread unit`).toMatch(/unitCents [!=]= null/);
    }
  });

  it('the Sign Up card reads the unit off the tournament, and a chip wallet only for a chip entry', () => {
    const hook = blankNonCode(read('src/hooks/useTournamentRegistration.ts'));
    expect(hook).toContain('tournamentService.readTournamentUnitCents(t.id)');
    expect(hook).toMatch(/unitCents: await unitCentsRead,/);
    // Started before the ticket lookup is awaited, so the card opens no later.
    expect(hook.indexOf('readTournamentUnitCents(t.id)')).toBeLessThan(
      hook.indexOf('await tournamentService.findTournamentEntryTicket(t.id)')
    );

    const service = blankNonCode(read('src/services/TournamentService.ts'));
    const reader = service.slice(service.indexOf('async readTournamentUnitCents('));
    const body = reader.slice(0, reader.indexOf('\n  }\n'));
    expect(body).toContain('.select(TOURNAMENT_ARENA_EMBED)');
    expect(body).toContain('return tournamentRowUnitCents(data);');

    const card = blankNonCode(read('src/components/tournament/signUpDialog.tsx'));
    expect(card).toMatch(/unitCents: number \| null;/);
    expect(card).toMatch(
      /if \(!current \|\| !userId \|\| usesTournamentTicket \|\| !pricedInChips\) \{/
    );
    expect(card).toMatch(/!usesTournamentTicket && !pricedInDiamonds && \(/);
  });
});
