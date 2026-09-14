/**
 * A DIAMOND SEAT KEEPS ITS SIDE FEATURES (Phase 7 line four).
 *
 * Skins, card decks, time banks, rabbit hunt, chat, voice and throwables were
 * never built for chips. Every one of them charges `profiles.diamonds` through
 * `deduct_diamonds`, which is the SAME wallet the custody reserve debits a
 * buy-in out of - so at a Diamond table they are not being ported, they are
 * being left alone, and the work of this line is proving that nothing gates
 * them by asset and nothing about them can reach a stake.
 *
 * Three properties, and each one is a way the integration could be wrong:
 *
 *   1. REACHABLE. No asset condition hides any of them at a Diamond table.
 *   2. SEPARATE. No charge door mentions custody, a seat or a stack; the money
 *      moves in the wallet and the stake lives in `poker_diamond_custody`, so a
 *      feature charge and a stake cannot be the same Diamond.
 *   3. IDEMPOTENT. Each charge carries a caller-held request id, so a lost
 *      response answers with the first receipt instead of charging twice.
 *
 * The live-schema half of this - that no feature function touches custody and
 * no custody function touches a feature table, in both directions - is in
 * docs/audits/2026-09-12-diamond-phase-7-feature-charges-and-side-features.md.
 * These are the call sites that audit describes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceStatement } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const SETTLEMENT = 'server/src/engine/ServerTableEngineSettlement.ts';
const TABLE_PAGE = 'src/pages/TablePage.tsx';
const THROWABLES = 'src/services/ThrowableService.ts';
const CHAT = 'src/hooks/useTableChat.ts';
const VOICE = 'src/hooks/useTableVoice.ts';
const THEME = 'src/components/table/ThemeSettingsModal.tsx';
const THROW_CONTROLLER = 'src/hooks/useTableAnimations.ts';
const RABBIT = 'src/components/table/RabbitHunt.tsx';
const TIME_BANK_STORE = 'src/components/table/TimeBankStoreModal.tsx';
const PLAYER_TOGGLES = 'src/hooks/useUserTableSettings.ts';

/** Every file that can charge for a side feature, and the door it charges at. */
const CHARGE_DOORS: Array<[string, string, string]> = [
  ['rabbit hunt', SETTLEMENT, 'fn_consume_rabbit_hunt_v2'],
  ['time banks', TABLE_PAGE, 'fn_purchase_time_banks_v2'],
  ['throwables', THROWABLES, 'fn_use_throwable_v2'],
  ['skins and card decks', THEME, 'fn_purchase_feature_v2'],
];

describe('every side feature is reachable at a Diamond table', () => {
  /* One entry per surface the checklist line names, and the whole FILE is read
     for each: these own no money and make no stake decision, so there is no
     legitimate reason for the arena's denomination to appear anywhere in them.
     `useUserTableSettings` is in the list because the rabbit-hunt button, the
     emoji overlay and the text-message toggle are read from it: it is a
     per-PLAYER row, so a player's own feature settings follow them to a
     Diamond seat unchanged, which is what a one-to-one clone means here. */
  it.each([
    ['chat', CHAT],
    ['voice', VOICE],
    ['throwables', THROWABLES],
    ['the throw controller', THROW_CONTROLLER],
    ['the rabbit hunt panel', RABBIT],
    ['the time bank store', TIME_BANK_STORE],
    ['skins and card decks', THEME],
    ['the per-player feature toggles', PLAYER_TOGGLES],
  ])('%s carries no asset condition at all', (_name, file) => {
    expect(code(file), `${file} gates on the arena asset`).not.toMatch(/arenaAsset/);
  });

  it.each(CHARGE_DOORS)('the %s charge is not gated on chips', (_name, file, door) => {
    const call = sliceStatement(read(file), `supabase.rpc('${door}'`);
    expect(call, `${file} does not call ${door}`).toContain(door);
    expect(code(file), `${file} refuses a non-chip table before charging`).not.toMatch(
      /arenaAsset !== 'chips'[\s\S]{0,120}(return|throw)[\s\S]{0,200}rpc\('fn_(consume_rabbit|purchase_time|use_throwable|purchase_feature)/
    );
  });

  /* REACHABILITY IS A PROPERTY OF THE CONTROLS, NOT A CENSUS OF THE GATES.

     The first version of this counted `arenaAsset` conditions in the table
     page and demanded the total stay under a number. That is precisely the
     magic window tests/helpers/sourceWindow.ts exists to argue against, and
     it was wrong in both directions at once: the number was guessed rather
     than measured (it said 8; the page holds 11), and even corrected it
     would have gone RED for a cashier change that touches no side feature,
     while staying GREEN for a gate added to the rabbit hunt in a commit that
     happened to delete an unrelated one.

     What this line actually promises is narrower and checkable. The controls
     belong to the SEAT, and not one of them asks what the seat is funded in.
     So each control is read to the end of its own declaration, and each
     element to its own closing token: both windows grow exactly as fast as
     the code they watch. */
  const IN_PAGE_CONTROLS: Array<[string, string]> = [
    ['the rabbit hunt reveal', 'const handleRabbitReveal = useCallback('],
    ['the time bank purchase', 'const handleBuyTimeBanks = useCallback('],
    ['the time bank store opener', 'const handleBuyTimeBank = useCallback('],
    ['the time bank activation', 'const handleActivateTimeBank = useCallback('],
  ];

  it.each(IN_PAGE_CONTROLS)('%s asks nothing about the arena asset', (_name, anchor) => {
    const declaration = sliceStatement(read(TABLE_PAGE), anchor);
    expect(declaration, `${anchor} reads the arena asset`).not.toMatch(/arenaAsset/);
  });

  /* And the same for what the page HANDS them. A control that is itself
     asset-blind still vanishes at a Diamond table if the element rendering it
     is passed an asset-derived prop, so the props are read too.

     The newline is part of the anchor, and it is not decoration. `<RabbitHunt`
     on its own first matches `Promise<RabbitHuntRevealResult>` nine thousand
     lines earlier - the generic is a literal `<RabbitHunt` too - and the
     window then ran from a type parameter to the next `/>` in the file, which
     is the collision tests/helpers/sourceWindow.ts warns about for anchors.
     Every element here carries enough props to be formatted one per line, so
     the tag ends its line and the type never does. */
  const IN_PAGE_ELEMENTS: Array<[string, string]> = [
    ['the rabbit hunt panel', '<RabbitHunt\n'],
    ['the time bank store', '<TimeBankStoreModal\n'],
    ['the table chat', '<TableChat\n'],
  ];

  it.each(IN_PAGE_ELEMENTS)('%s is handed no asset-derived prop', (_name, element) => {
    const jsx = sliceBetween(read(TABLE_PAGE), element, '/>');
    expect(jsx, `${element} is not rendered by the table page`).toContain(element);
    expect(jsx, `${element} receives the arena asset`).not.toMatch(/arenaAsset|arenaIdentity/);
  });
});

describe('a side feature charge cannot reach a stake', () => {
  it.each(CHARGE_DOORS)('the %s charge names no custody, seat or stack', (_name, file, door) => {
    const call = sliceStatement(read(file), `supabase.rpc('${door}'`);
    for (const forbidden of ['poker_diamond_custody', 'table_seats', 'fn_poker_diamond']) {
      expect(call, `${door} reaches ${forbidden}`).not.toContain(forbidden);
    }
  });

  /* The Diamond hand excludes every CHIP obligation from settlement. A side
     feature is not one of them: it was charged in the wallet long before the
     hand settled, and suppressing it here would mean a player paid for a rabbit
     hunt they did not get. */
  it('the Diamond settlement suppresses chip obligations and no side feature', () => {
    const src = code(SETTLEMENT);
    const diamondExclusions = src.match(/isDiamondCash[\s\S]{0,4000}/g)?.join('\n') ?? '';
    for (const feature of ['rabbit', 'time_bank', 'throwable', 'feature_purchase']) {
      expect(
        new RegExp(`isDiamondCash[^\\n]{0,80}${feature}`, 'i').test(diamondExclusions),
        `${feature} is suppressed for a Diamond hand`
      ).toBe(false);
    }
  });
});

describe('every side feature charge is idempotent under a caller-held id', () => {
  it.each([
    ['rabbit hunt', SETTLEMENT, 'fn_consume_rabbit_hunt_v2'],
    ['time banks', TABLE_PAGE, 'fn_purchase_time_banks_v2'],
    ['throwables', THROWABLES, 'fn_use_throwable_v2'],
  ])('%s sends a request id with the charge', (_name, file, door) => {
    const call = sliceStatement(read(file), `supabase.rpc('${door}'`);
    expect(call, `${door} is called without a request id`).toMatch(/p_request_id/);
  });

  it('the rabbit hunt id is derived, so the same hand cannot be charged twice', () => {
    /* A random id per attempt would make every retry a new purchase. This one is
       a uuidv5 of the table, the hand and the player, so the SAME hand asks the
       same question however many times the engine retries it. */
    const fn = read(SETTLEMENT);
    const window = sliceStatement(fn, "'club-arena.rabbit-hunt.v1'");
    expect(window).toMatch(/uuidv5/);
    expect(window).toMatch(/this\.tableId\.toLowerCase\(\)/);
  });
});
