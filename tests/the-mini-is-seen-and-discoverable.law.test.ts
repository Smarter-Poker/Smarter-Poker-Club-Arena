/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MINI IS SEEN AND DISCOVERABLE LIKE THE MAIN
 *  Dan, 2026-09-09: "MINI BBJ NEEDS TO BE SEEN AND DISCOVERABLE LIKE THE BBJ
 *  CURRENTLY IS"; 2026-09-11, with the popup in front of him: "THE BBJ FRAME
 *  NEEDS TO BE THINNER ... UNDER IT SHOULD BE A MINI BBJ AMOUNT THAT IS DYNAMIC
 *  AND ADJUSTS WITH THE TABLE ... INSIDE THE BBJ POP UP, YOU NEED TO SEPERATE
 *  BBJ WINERS, AND MINI BBJ WINNERS. THERE SHOULD BE A CLICKABLE TAB FOR THE
 *  MINI (SHOULDN'T BE A MAIN FEATURE). SAME THING WITH THE BASIC AND THE
 *  QUALIFYING HANDS PAGES."
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS LAW EXISTS, measured 2026-09-11. Two days after the mini launched it
 * had paid nineteen times (11,600 chips) and a player could learn it existed
 * from exactly three places, all of them AFTER a hit: the celebration on the
 * hitting table, the ticker's MINI chip, and the winners list. Nothing before a
 * hand said a second tier existed, what it paid, what qualified for it, or that
 * the "Backup Pool" figure on the jackpot page is what funds it. The engine,
 * the payout RPC and the ledger all knew; the surfaces did not.
 *
 * The pins below are the surfaces, and the two money rules that keep them
 * honest:
 *
 *   1. A SHOWN MINI IS A PAYABLE MINI. `fn_bbj_mini_payout` refuses when
 *      backup - parked - amount < floor. Every surface gates on the `payable`
 *      flag that reproduces exactly that test, so the felt never promises a
 *      mini the engine is about to refuse.
 *   2. THE CLIENT'S RULE MIRRORS THE ENGINE'S. `detectMiniBBJHit` picks the
 *      family from the MAIN rule's hand rank for the variant; `config/bbjMini`
 *      picks it the same way, from the same table, so the two cannot disagree
 *      about which bar a table is under.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceCssRule } from './helpers/sourceWindow';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const miniConfig = read('src/config/bbjMini.ts');
const miniFeed = read('src/lib/bbjMiniFeed.ts');
const serverRake = read('server/src/config/RakeConfig.ts');
const plate = read('src/components/table/BadBeatJackpot.tsx');
const plateCss = read('src/components/table/BadBeatJackpot.css');
const modal = read('src/components/bbj/BBJInfoModal.tsx');
const basic = read('src/components/bbj/BBJBasicPanel.tsx');
const qualifying = read('src/components/bbj/BBJQualifyingHands.tsx');
const hits = read('src/components/bbj/BBJRecentHits.tsx');
const rulesPanel = read('src/components/bbj/BBJRulesPanel.tsx');
const jackpotPage = read('src/pages/BadBeatJackpotPage.tsx');
const lobby = read('src/pages/ClubHomePage.tsx');
const tablePage = read('src/pages/TablePage.tsx');
const modalsLayer = read('src/components/table/TableModalsLayer.tsx');
const handDetail = read('src/components/bbj/BBJHandDetail.tsx');
const adminPanel = read('src/components/bbj/BBJAdminAnalytics.tsx');
const engineBbj = read('server/src/services/supabase/bbj.ts');
const readPathSql = read(
  'supabase/migrations/20260911133435_the_mini_jackpot_is_seen_and_discoverable_like_the_main.sql'
);
const winnersSql = read(
  'supabase/migrations/20260911133927_the_winners_list_can_be_asked_for_one_jackpot_at_a_time.sql'
);

describe('the read path exists and answers the same question the payout asks', () => {
  it('fn_bbj_mini_for_club reproduces the payout RPC refusal exactly', () => {
    // fn_bbj_mini_payout: IF v_backup - fn_bbj_parked_reserve(...) - v_amount < v_floor THEN refuse.
    // Inverted here, term for term, so `payable` cannot drift from what pays.
    expect(readPathSql).toMatch(
      /COALESCE\(pool\.backup_balance, 0\) - parked_row\.parked - mt\.amount\s*>= floor_row\.reserve_floor\) AS payable/
    );
    expect(readPathSql).toContain("public.fn_bbj_parked_reserve(pool.pool_id, 'backup')");
  });

  it('it is a read: no write, no chip movement, and it is not browser-anonymous', () => {
    const fn = readPathSql.slice(
      readPathSql.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_mini_for_club'),
      readPathSql.indexOf('-- 2. The hand drilldown')
    );
    expect(fn).toContain('STABLE SECURITY DEFINER');
    for (const forbidden of ['INSERT', 'UPDATE ', 'DELETE', 'fn_bbj_mini_payout', 'fn_ca_burn']) {
      expect(fn.toUpperCase()).not.toContain(forbidden.toUpperCase().trim() + ' INTO');
    }
    expect(readPathSql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_bbj_mini_for_club(uuid) FROM PUBLIC, anon;'
    );
    expect(readPathSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, service_role;'
    );
  });

  it('the winners list can be asked for one jackpot, and has exactly one signature', () => {
    expect(winnersSql).toMatch(/p_kind text DEFAULT NULL/);
    expect(winnersSql).toMatch(
      /\(p_kind IS NULL OR COALESCE\(p\.kind, 'main'\) = p_kind\)[\s\S]*?ORDER BY p\.created_at DESC/
    );
    // total_hits must count what the list counts, or the caption lies.
    expect(winnersSql).toMatch(
      /pool_total AS \([\s\S]*?\(p_kind IS NULL OR COALESCE\(p\.kind, 'main'\) = p_kind\)/
    );
    // Two overloads of one name make PostgREST refuse a call that fits both.
    expect(winnersSql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid);'
    );
    expect(winnersSql).toMatch(/p\.proname = 'fn_bbj_recent_hits'\) <> 1 THEN/);
  });

  it('the operator panel gained the mini without changing what its old columns mean', () => {
    expect(readPathSql).toMatch(/mini_hit_count bigint/);
    expect(readPathSql).toMatch(/mini_paid_all_time numeric/);
    expect(readPathSql).toMatch(/mini_reserve_floor numeric/);
    expect(readPathSql).toMatch(/mini_available numeric/);
    // hit_count and total_paid_all_time still read EVERY row of bbj_winners.
    expect(readPathSql).toMatch(
      /hits AS \([\s\S]*?FROM public\.bbj_winners WHERE pool_id = p_pool_id\s*\n\s*\)/
    );
  });
});

describe('the client rule mirrors the engine rule', () => {
  it('both pick the family from the MAIN rule hand rank for the variant', () => {
    expect(serverRake).toContain("const isHoldemFamily = qualifying.handRank === 'full_house';");
    expect(miniConfig).toContain(
      "return q.handRank === 'full_house' ? 'holdem_aces_full' : 'plo_quads';"
    );
  });

  it('the two rule names and the two engine labels are identical strings', () => {
    expect(serverRake).toMatch(
      /miniRule\?: 'holdem_aces_full' \| 'plo_quads';|'holdem_aces_full'\s*:\s*'plo_quads'/
    );
    expect(miniConfig).toContain("export type BBJMiniRule = 'holdem_aces_full' | 'plo_quads';");
    // qualifyingHandLabel is what the celebration prints; the client must not
    // invent a different wording for the same bar.
    expect(serverRake).toContain(
      "qualifyingHandLabel: isHoldemFamily ? 'Aces Full Or Better' : 'Quads Or Better',"
    );
    expect(miniConfig).toMatch(/holdem_aces_full: 'Aces Full Or Better',/);
    expect(miniConfig).toMatch(/plo_quads: 'Quads Or Better',/);
  });

  it('an ineligible variant has no mini, exactly as the engine refuses one', () => {
    // engine: if (!qualifying || qualifying.eligible === false || !qualifying.handRank) return noHit;
    expect(serverRake).toMatch(
      /if \(!qualifying \|\| qualifying\.eligible === false \|\| !qualifying\.handRank\) return noHit;/
    );
    expect(miniConfig).toMatch(/if \(q\.eligible === false \|\| !q\.handRank\) return null;/);
  });

  it('the split the client prints is the split the RPC pays', () => {
    expect(miniConfig).toContain(
      'export const BBJ_MINI_SPLIT = { loser: 0.5, winner: 0.25, table: 0.25 } as const;'
    );
  });
});

describe('the feed refuses to guess, and never promises a refused mini', () => {
  it('a failed read keeps the last snapshot and reports - it never publishes zero', () => {
    expect(miniFeed).toMatch(/reportError\(error, 'bbjMiniFeed\.read_failed'/);
    const readOnce = miniFeed.slice(miniFeed.indexOf('async function readOnce'));
    // The error branch returns before anything is published.
    expect(readOnce).toMatch(/if \(error\) \{[\s\S]{0,200}?return;/);
  });

  it('a hit re-reads the reserve at once rather than showing a stale amount', () => {
    const hitFeed = read('src/lib/bbjHitFeed.ts');
    expect(hitFeed).toContain("import { refreshBbjMini } from './bbjMiniFeed';");
    expect(hitFeed).toMatch(
      /if \(\(row\.kind \|\| 'main'\) !== 'main'\) \{[\s\S]*?refreshBbjMini\(\);[\s\S]*?return;/
    );
  });

  it('the tier is chosen by the same cascade the server uses (first ceiling not exceeded)', () => {
    const fn = miniFeed.slice(miniFeed.indexOf('export function miniTierForBB'));
    expect(fn).toMatch(/\.sort\(\(a, b\) => a\.maxBB - b\.maxBB\)/);
    expect(fn).toMatch(/if \(bigBlind <= t\.maxBB\) return t;/);
  });

  it('every surface that shows an amount gates on payable', () => {
    expect(modalsLayer).toMatch(
      /const bbjMiniAmount = bbjMiniTier && bbjMiniTier\.payable \? bbjMiniTier\.amount : null;/
    );
    expect(lobby).toMatch(/\.filter\(\(t\) => t\.enabled && t\.payable\)/);
    expect(jackpotPage).toMatch(/\.filter\(\(t\) => t\.enabled && t\.payable\)/);
    // and the plate draws nothing at all when there is no payable amount
    expect(plate).toContain("const showMini = typeof miniAmount === 'number' && miniAmount > 0;");
  });
});

describe('the felt: a thinner frame, and the mini under it', () => {
  it('the frame is 2px, not 5px, and the inner bezel thinned with it', () => {
    const base = plateCss.slice(
      plateCss.indexOf('.bbj-widget {'),
      plateCss.indexOf('/* Inner nickel bezel')
    );
    expect(base).toContain('border: 2px solid transparent;');
    expect(base).not.toContain('border: 5px solid transparent;');
    expect(sliceCssRule(plateCss, '.bbj-widget::before {')).toContain('padding: 1px;');
  });

  it('the mini row is its own element under the plate, with the flat amount', () => {
    expect(plate).toContain('className="bbj-mini-plate"');
    expect(plate).toContain('MINI BBJ');
    expect(plate).toMatch(/\{Math\.trunc\(miniAmount as number\)\.toLocaleString\('en-US'\)\}/);
    expect(plateCss).toContain('.bbj-mini-plate {');
  });

  it('it opens the same popup the plate opens', () => {
    const row = plate.slice(plate.indexOf('className="bbj-mini-plate"'));
    expect(row).toMatch(/onClick=\{\(\) => onOpenDetails\?\.\(\)\}/);
    expect(row).toMatch(/if \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
  });

  it('the felt reserves the row it draws, and only the row it draws', () => {
    // --sp-bbj-h is what TablePage.css reserves. It is the plate plus the mini
    // row, and the mini half is 0 until the page stamps data-bbj-mini="1".
    expect(plateCss).toMatch(/--sp-bbj-plate-h: 22px;/);
    expect(plateCss).toMatch(/--sp-bbj-mini-h: 0px;/);
    expect(plateCss).toMatch(
      /--sp-bbj-h: calc\(var\(--sp-bbj-plate-h\) \+ var\(--sp-bbj-mini-h\)\);/
    );
    expect(plateCss).toMatch(
      /\.table-page\[data-bbj-mini='1'\] \{\s*--sp-bbj-mini-h: 14px;\s*--sp-bbj-h: calc\(var\(--sp-bbj-plate-h\) \+ var\(--sp-bbj-mini-h\)\);/
    );
    // TablePage.css still derives its reserve from the variable, not a literal.
    expect(read('src/pages/TablePage.css')).toContain(
      '--sp-table-top: calc(var(--sp-bbj-h, 22px) + 14px + var(--sp-page-inset-top));'
    );
  });

  it('the stamp and the render ask ONE helper, so they cannot disagree', () => {
    const helper = read('src/components/table/bbjPlateVisibility.ts');
    expect(helper).toContain('export function isBbjPlateShown');
    expect(modalsLayer).toContain(
      'isBbjPlateShown({ gameType, isTournament, tournamentId, maxPlayers })'
    );
    expect(tablePage).toContain('data-bbj-mini=');
    expect(tablePage).toMatch(/isBbjPlateShown\(\{[\s\S]{0,240}?\}\) &&\s*bbjMini\?\.enabled/);
    // the old inline condition must not survive beside the helper
    expect(modalsLayer).not.toMatch(
      /bbjInfo\.eligible &&\s*!isTournament &&\s*!tournamentId &&\s*maxPlayers > 2/
    );
  });
});

describe('the popup: three pages, each with a mini of its own', () => {
  it('a second row, not a fourth tab - the mini is not a main feature', () => {
    expect(modal).toContain("type Tier = 'main' | 'mini';");
    expect(modal).toContain('className="bbj-modal__tiers"');
    expect(modal).toMatch(/Bad Beat Jackpot\s*<\/button>/);
    expect(modal).toMatch(/>\s*Mini\s*<\/button>/);
    // The three page tabs are unchanged.
    expect(modal).toMatch(
      /const TABS: Array<\{ key: Tab; label: string \}> = \[\s*\{ key: 'winner', label: 'Winner' \},\s*\{ key: 'basic', label: 'Basic' \},\s*\{ key: 'qualifying', label: 'Qualifying Hands' \},/
    );
  });

  it('the winners list is asked for one jackpot at a time and remounts when it changes', () => {
    expect(modal).toMatch(/<BBJRecentHits\s+key=\{tier\}/);
    expect(modal).toMatch(/kind=\{tier\}/);
    expect(hits).toMatch(/kind\?: 'main' \| 'mini' \| 'all';/);
    expect(hits).toMatch(/const kindArg = kind === 'all' \? null : kind;/);
    expect(hits).toMatch(/p_kind: kindArg,/);
    // the caption names the list it is counting
    expect(hits).toMatch(/\$\{kind === 'mini' \? 'Mini ' : ''\}Bad Beat Jackpot Winners/);
  });

  it('the mini winners list never borrows the main rule examples', () => {
    // EXAMPLE_HITS illustrate aces full of jacks / quad kings - the MAIN bar.
    /* The rule is an ORDER, not a region: the mini empty state must RETURN
       before control can reach the example rows, so a mini list can never be
       seeded with hands that teach the main bar. Stated as the order itself
       rather than as a window over one of the two branches. */
    const miniEmpty = hits.indexOf("hits.length === 0 && kind === 'mini'");
    const examples = hits.indexOf('EXAMPLE_HITS.map');
    expect(miniEmpty).toBeGreaterThan(-1);
    expect(examples).toBeGreaterThan(miniEmpty);
    expect(hits).toContain('No Mini Jackpot Has Been Paid On This Pool Yet');
  });

  it('Basic shows the mini schedule from the live feed, never a client copy', () => {
    expect(basic).toMatch(/kind\?: 'main' \| 'mini';/);
    expect(basic).toContain('export function BBJMiniBasicPanel');
    expect(basic).toMatch(/if \(kind === 'mini'\) return <BBJMiniBasicPanel/);
    expect(basic).toContain('Mini Pays');
    expect(basic).toMatch(/'Paused - Reserve At Floor'/);
    expect(modal).toMatch(/<BBJBasicPanel kind="mini" mini=\{mini\} highlightBB=\{bigBlind\}/);
    // No hard-coded mini amounts anywhere in the client.
    for (const file of [basic, modal, plate, miniConfig, rulesPanel]) {
      expect(file).not.toMatch(/\b(250|425|700|950|1200|1500)\b\s*(?:\/\/.*)?$/m);
    }
  });

  it('Qualifying Hands shows the mini bar per game, with its own cards', () => {
    expect(qualifying).toMatch(/kind\?: 'main' \| 'mini';/);
    expect(qualifying).toContain('const MINI_BLOCKS: VariantBlock[] = BLOCKS.map');
    expect(qualifying).toMatch(/const blocks = kind === 'mini' \? MINI_BLOCKS : BLOCKS;/);
    expect(qualifying).toMatch(/\{blocks\.map\(\(b\) => \{/);
    expect(modal).toMatch(/<BBJQualifyingHands\s+kind=\{tier\}/);
    // and it says what the mini drops, which is the whole point of the tier
    expect(qualifying).toContain('No Ace-In-The-Hole Rule And No Both-Cards-Must-Play Rule');
  });

  it('the header follows the row rather than showing the main pool under a mini tab', () => {
    expect(modal).toMatch(/\{isMini \? 'MINI BAD BEAT JACKPOT' : 'BAD BEAT JACKPOT'\}/);
    expect(modal).toMatch(/bbj-modal__amount--mini/);
    expect(modal).toMatch(/miniTier\.payable[\s\S]{0,200}?'Paused'/);
  });
});

describe('every other surface the main appears on', () => {
  it('the lobby tile carries the mini range', () => {
    expect(lobby).toContain(
      "import { watchBbjMini, type BbjMiniSnapshot } from '../lib/bbjMiniFeed';"
    );
    expect(lobby).toContain('className="lobby-bbj__mini"');
    expect(read('src/pages/ClubHomePage.css')).toContain('.lobby-bbj__mini {');
    // and it is torn down with the pool feed, not leaked
    expect(lobby).toMatch(/stopBbjMini\?\.\(\);/);
  });

  it('the jackpot page says what the backup pool is for, and lists mini winners', () => {
    expect(jackpotPage).toContain('Funds The Mini Jackpot');
    expect(jackpotPage).toMatch(/<BBJRulesPanel poolAmount=\{[^}]*\} mini=\{pageMini\} \/>/);
    expect(jackpotPage).toMatch(/kind=\{historyKind\}/);
    expect(jackpotPage).toMatch(/setHistoryKind\('mini'\)/);
    expect(rulesPanel).toMatch(/Mini Jackpot\s*<\/button>/);
    expect(rulesPanel).toMatch(/mini\?: BbjMiniSnapshot \| null;/);
  });

  it('the hand drilldown says which jackpot it was', () => {
    expect(handDetail).toMatch(
      /\{\(detail\.kind \?\? detail\.jackpot\?\.kind\) === 'mini' \? 'Mini BBJP Winners' : 'BBJP Winners'\}/
    );
    expect(readPathSql).toMatch(/'kind',\s*COALESCE\(\(SELECT kind FROM pay\), 'main'\)/);
  });

  it('the recipient notification names the mini', () => {
    expect(engineBbj).toMatch(
      /const jackpotName = params\.kind === 'mini' \? 'Mini Bad Beat Jackpot' : 'Bad Beat Jackpot';/
    );
    expect(engineBbj).toMatch(/title: r\.pending \? `\$\{jackpotName\} - Payment Pending`/);
    expect(engineBbj).toMatch(/kind: params\.kind === 'mini' \? 'mini' : 'main',/);
  });

  it('the pending and paid toasts name the mini', () => {
    expect(tablePage).toMatch(
      /handState\.kind === 'mini'\s*\?\s*'Mini Bad Beat Jackpot Hit\. Your Share Is Being Paid/
    );
    expect(tablePage).toMatch(
      /const paidLabel = handState\.kind === 'mini' \? 'Mini Bad Beat Jackpot' : 'Bad Beat Jackpot';/
    );
  });

  it('the operator panel shows the mini count, spend and reserve headroom', () => {
    expect(adminPanel).toContain('Mini Hits');
    expect(adminPanel).toContain('Mini Paid');
    expect(adminPanel).toContain('Mini Headroom');
    expect(adminPanel).toMatch(/mini_available\?: number \| null;/);
    // the union dashboard's backup tile says what it funds
    expect(read('src/pages/UnionDashboardPage.tsx')).toContain('Backup Jackpot - Funds The Mini');
  });
});

describe('a club without a union owns its mini switch (Dan 2026-09-11)', () => {
  const toggleSql = read(
    'supabase/migrations/20260911140713_a_club_without_a_union_owns_its_mini_jackpot_switch.sql'
  );
  const panel = read('src/components/bbj/BBJMiniPanel.tsx');

  it('the default is ON, so a new club has the mini from its first hand', () => {
    expect(toggleSql).toMatch(
      /ADD COLUMN IF NOT EXISTS mini_enabled boolean NOT NULL DEFAULT true;/
    );
    // asserted by the migration itself, so a later edit that drops the default
    // cannot apply quietly
    expect(toggleSql).toMatch(
      /IF v_default IS DISTINCT FROM 'true' OR v_notnull IS NOT TRUE THEN\s*RAISE EXCEPTION/
    );
    // and it may not switch anything off on the way in
    expect(toggleSql).toMatch(
      /SELECT count\(\*\) INTO v_off FROM public\.bbj_pools WHERE mini_enabled IS NOT TRUE;/
    );
  });

  it('the payout reads the switch from the row it already holds FOR UPDATE', () => {
    const fn = toggleSql.slice(
      toggleSql.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout'),
      toggleSql.indexOf('REVOKE ALL ON FUNCTION public.fn_bbj_mini_payout')
    );
    expect(fn).toMatch(
      /COALESCE\(mini_enabled, true\)\s*INTO v_backup, v_floor, v_club_id, v_pool_mini_enabled\s*FROM public\.bbj_pools WHERE id = p_pool_id FOR UPDATE;/
    );
    expect(fn).toMatch(
      /IF NOT v_pool_mini_enabled THEN\s*RETURN QUERY SELECT false, false, 'mini_disabled_for_club'::text/
    );
    // A club that switches off after a hit was queued must still have that
    // hit's parked shares settled: the idempotency branch comes FIRST.
    expect(fn.indexOf('v_existing IS NOT NULL')).toBeLessThan(
      fn.indexOf('IF NOT v_pool_mini_enabled')
    );
  });

  it('the switch names its own actor, and refuses a caller with no session', () => {
    /* check-definer-authorization blocked this function on its first push: a
       SECURITY DEFINER writer a browser can execute, whose actor arrived one
       call down inside fn_is_club_admin_uid. Named here now - and that also
       closed a real case, since a service-role caller has no auth.uid() and
       used to fall through to the misleading `not_a_club_admin`. */
    const actorSql = read(
      'supabase/migrations/20260911142515_the_mini_switch_names_who_is_asking.sql'
    );
    expect(actorSql).toMatch(/v_actor := auth\.uid\(\);/);
    expect(actorSql).toMatch(
      /IF v_actor IS NULL THEN\s*RETURN jsonb_build_object\('ok', false, 'reason', 'not_signed_in'\);/
    );
    // the actor is the SESSION, never a parameter
    expect(actorSql).not.toMatch(/v_actor := p_/);
    // and the migration asserts both, so a later replace cannot drop them quietly
    expect(actorSql).toMatch(/RAISE EXCEPTION 'the mini switch must name its own actor'/);
  });

  it('only a club admin may set it, and never for a club inside a union', () => {
    /* Declared in the actor migration, not the column one: check-definer-authorization
       judges each FILE on its own body, so the only file that declares this
       function is the one whose body names auth.uid(). */
    const setterSql = read(
      'supabase/migrations/20260911142515_the_mini_switch_names_who_is_asking.sql'
    );
    const fn = setterSql.slice(
      setterSql.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_set_club_mini_enabled')
    );
    expect(fn).toMatch(
      /IF NOT public\.fn_is_club_admin_uid\(p_club_id\) THEN\s*RETURN jsonb_build_object\('ok', false, 'reason', 'not_a_club_admin'\);/
    );
    expect(fn).toMatch(
      /IF v_union IS NOT NULL THEN\s*RETURN jsonb_build_object\('ok', false, 'reason', 'union_club_follows_the_union'/
    );
    // Authorize BEFORE explaining: a stranger must not learn a club's union
    // shape from a refusal.
    expect(fn.indexOf('fn_is_club_admin_uid')).toBeLessThan(fn.indexOf('v_union IS NOT NULL'));
    expect(setterSql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_bbj_set_club_mini_enabled(uuid, boolean) FROM PUBLIC, anon;'
    );
    // and the column migration must NOT declare it - one declaration, the safe one
    expect(toggleSql).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_bbj_set_club_mini_enabled'
    );
  });

  it('the switch reaches every surface through the one feed', () => {
    // fn_bbj_mini_for_club folds it into BOTH `enabled` and every `payable`,
    // so a surface reading only `payable` cannot promise a switched-off mini.
    expect(toggleSql).toMatch(
      /\(pool_row\.mini_enabled\s*AND mt\.enabled\s*AND COALESCE\(pool\.backup_balance, 0\) - parked_row\.parked - mt\.amount\s*>= pool_row\.reserve_floor\) AS payable/
    );
    expect(toggleSql).toMatch(
      /\(pool_row\.mini_enabled\s*AND EXISTS \(SELECT 1 FROM public\.bbj_mini_tiers t WHERE t\.enabled\)\) AS enabled/
    );
    expect(miniFeed).toMatch(/clubSwitch: row\.club_switch !== false,/);
    expect(miniFeed).toMatch(/canToggle: row\.can_toggle === true,/);
  });

  it('the settings page draws a control only where the database would accept the write', () => {
    expect(panel).toMatch(/const showSwitch = mini\.canToggle && canEdit;/);
    // `canEdit` may only narrow, never widen
    expect(panel).not.toMatch(/showSwitch = canEdit \|\|/);
    // a union club is told why rather than shown nothing
    expect(panel).toContain('Only The Union Can Turn It On Or Off');
    // and the button reflects the database after the write, not the click
    expect(panel).toMatch(/const res = await setBbjMiniEnabled\(clubId, next\);/);
    expect(panel).toMatch(
      /if \(!res\.ok\) \{[\s\S]{0,160}?toast\.error\(refusalText\(res\.reason\)/
    );
    expect(read('src/pages/ClubSettingsPage.tsx')).toContain('<BBJMiniPanel clubId={clubId}');
  });

  it('a switched-off mini is still written down, through the reason the engine already records', () => {
    // processMiniBBJPayout passes the RPC's `refused` straight through, and
    // settlement records `mini_refused:<reason>` - so the new refusal needs no
    // new engine branch, and a club can see what its own switch turned away.
    expect(engineBbj).toMatch(
      /reason: outcome\.status === 'already_paid' \? 'already_paid' : outcome\.reason,/
    );
    expect(read('server/src/engine/ServerTableEngineSettlement.ts')).toMatch(
      /reason: `mini_refused:\$\{outcome\.reason \|\| 'unspecified'\}`/
    );
  });
});

describe('what the mini deliberately does NOT do', () => {
  it('it still does not take over every screen on the platform', () => {
    // BBJ phase 6's rule, unchanged: a mini fires about four times a day and
    // must not put a takeover on every open page. refreshBbjMini() is a read.
    const hitFeed = read('src/lib/bbjHitFeed.ts');
    const branch = hitFeed.slice(
      hitFeed.indexOf("if ((row.kind || 'main') !== 'main')"),
      hitFeed.indexOf('THE HIT IS REAL BEFORE ANY OF THIS RUNS')
    );
    expect(branch).toContain('return;');
    expect(branch).not.toMatch(/emit\(|BBJ_HIT_GLOBAL/);
  });

  it('the mini row is not drawn where the plate itself is not drawn', () => {
    const helper = read('src/components/table/bbjPlateVisibility.ts');
    expect(helper).toMatch(/if \(ctx\.isTournament \|\| ctx\.tournamentId\) return false;/);
    expect(helper).toMatch(/if \(!\(ctx\.maxPlayers > 2\)\) return false;/);
    expect(helper).toMatch(/gameType === 'spin' \|\| gameType === 'spins'/);
  });
});
