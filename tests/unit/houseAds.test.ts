/**
 * HOUSE ADS — the rules that must not drift back.
 *
 * Source-pinned rather than behaviour-mocked, the way this repo pins its
 * engine/client contracts (see winningCardHighlight.test.ts): the things worth
 * guarding here are decisions Dan made out loud, and the failure mode is
 * somebody quietly re-adding one of them months from now.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const SERVICE = read('src/services/AdService.ts');
const ROTATOR = read('src/components/ads/HouseAdRotator.tsx');
const ROTATOR_CSS = read('src/components/ads/HouseAdRotator.css');
const ADMIN = read('src/pages/admin/HouseAdsPage.tsx');
const PICTURE_MIGRATION = read('supabase/migrations/20260903200000_an_advert_is_a_picture_now.sql');
const CAP_MIGRATION = read('supabase/migrations/20260828032000_ad_cap_is_per_surface.sql');
const SUPPRESSION_MIGRATION = read(
  'supabase/migrations/20260828055000_suppression_countable_by_an_operator.sql'
);

describe('VIP members see house ads (Dan 2026-08-27)', () => {
  /* "even vips will see ads remove that for now." The ad-free promise had been
     SOLD in the present tense on the Diamond Store and repeated by Geeves, so
     the risk runs both ways: someone re-adding suppression here, or someone
     re-advertising ad-free over there. */
  it('the ad service contains no VIP suppression', () => {
    // A comment may mention VIP; a code path must not gate on it.
    const code = SERVICE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/is_?[Vv]ip/);
    expect(code).not.toMatch(/isVIP/);
  });

  it('records the ruling so the next reader does not "fix" it back', () => {
    expect(SERVICE).toMatch(/even vips will see ads/i);
  });
});

describe('an advert is a picture now (Dan 2026-09-03)', () => {
  /* "add the lobby strip, post session modal. i want to have it as 3 rotating
     images for now." And: "IF A PAGE SHRINKS, THE IMAGE SHOULD SHRINK AS WELL,
     IT SHOULD NEVER BE CUT OFF, OR DISTORTED BY PAGES CHANGING SIZE." */
  const LOBBY = read('src/pages/ClubHomePage.tsx');
  const SESSION = read('src/components/session/SessionSummaryHost.tsx');

  it('the text strip is gone and nothing imports it', () => {
    expect(() => read('src/components/lobby/LobbyAdStrip.tsx')).toThrow();
    expect(LOBBY).not.toMatch(/LobbyAdStrip/);
  });

  it('BOTH surfaces mount the rotator - the mount, not just the file', () => {
    /* The house bug shape, and this time it actually happened: #1759 rebuilt
       the lobby top and dropped the strip's mount. The component, its CSS, its
       placements and 85 pins on its internals all survived, so nothing went
       red, and the busiest ad surface served nobody for five days. */
    expect(LOBBY).toMatch(/import HouseAdRotator from '\.\.\/components\/ads\/HouseAdRotator'/);
    expect(LOBBY).toMatch(/<HouseAdRotator[\s\n]+slot="lobby_strip"/);
    expect(SESSION).toMatch(/import HouseAdRotator from '\.\.\/ads\/HouseAdRotator'/);
    expect(SESSION).toMatch(/<HouseAdRotator[\s\n]+slot="session_summary"/);
  });

  it('the session summary hands the rotator the club the store remembers', () => {
    // Spins and the jackpot carry {clubId}; without a club the resolver drops them.
    expect(SESSION).toMatch(/useUserStore\(\(s\) => s\.currentClubId\)/);
    expect(SESSION).toMatch(/clubId=\{currentClubId\}/);
  });

  it('shows only creatives that have a picture, and nothing at all otherwise', () => {
    expect(ROTATOR).toMatch(/rows\.filter\(\(a\) => isSafeAdImage\(a\.imageUrl\)\)/);
    expect(ROTATOR).toMatch(/if \(!ad\) return null;/);
    // No headline / body / glyph fallback rendered as text in a picture slot.
    expect(ROTATOR).not.toMatch(/house-ad__glyph|house-ad__headline/);
  });

  it('rotates three, and never faster than three seconds', () => {
    expect(ROTATOR).toMatch(/limit = 3/);
    expect(ROTATOR).toMatch(/const MIN_INTERVAL_MS = 3000;/);
    expect(ROTATOR).toMatch(/Math\.max\(MIN_INTERVAL_MS, intervalMs\)/);
  });

  it('scales with the page and is never cut off or distorted', () => {
    // A responsive image with a fixed aspect ratio: the box owns the shape,
    // the picture is contained inside it.
    expect(ROTATOR).toMatch(/style=\{\{ aspectRatio: ratio \}\}/);
    expect(ROTATOR).toMatch(/lobby_strip: '6 \/ 1'/);
    expect(ROTATOR).toMatch(/session_summary: '3 \/ 1'/);
    const img = ROTATOR_CSS.slice(ROTATOR_CSS.indexOf('.ad-rotator__image {'));
    expect(img).toMatch(/object-fit: contain;/);
    expect(ROTATOR_CSS).toMatch(/\.ad-rotator \{[\s\S]*?width: 100%;/);
    expect(ROTATOR_CSS).not.toMatch(/object-fit: cover/);
  });

  it('the creative lives on the placement, per surface, and stays same-origin', () => {
    expect(PICTURE_MIGRATION).toMatch(
      /alter table public\.ad_placement\s+add column if not exists image_url text;/
    );
    expect(PICTURE_MIGRATION).toMatch(/ad_placement_image_is_same_origin/);
    expect(PICTURE_MIGRATION).toMatch(/COALESCE\(pl\.image_url, c\.image_url\) AS image_url/);
    // Exactly three active placements on each picture surface, asserted in the migration itself.
    expect(PICTURE_MIGRATION).toMatch(/expected 3/);
  });

  it('the fade honours Animation Speed and reduced motion collapses motion, not meaning', () => {
    expect(ROTATOR_CSS).toMatch(/calc\(320ms \* var\(--animation-speed, 1\)\)/);
    // Reduced motion drops the fade; the rotation still advances so every
    // creative is still reachable (CLAUDE.md 10.6).
    expect(ROTATOR).toMatch(/prefers-reduced-motion: reduce/);
    expect(ROTATOR).not.toMatch(/if \(reduced\) return;/);
  });

  it('a seen ad is a different event from a rendered one', () => {
    expect(SERVICE).toMatch(/'impression' \| 'viewable' \| 'click' \| 'dismiss'/);
    expect(SERVICE).toMatch(/logViewable\(/);
    expect(PICTURE_MIGRATION).toMatch(
      /check \(event_type in \('impression', 'viewable', 'click', 'dismiss'\)\)/
    );
    // MRC / IAB: half the pixels, one continuous second, measured by observer.
    expect(ROTATOR).toMatch(/const VIEWABLE_RATIO = 0\.5;/);
    expect(ROTATOR).toMatch(/const VIEWABLE_MS = 1000;/);
    expect(ROTATOR).toMatch(/new IntersectionObserver\(/);
    expect(ROTATOR).toMatch(/AdService\.logViewable\(\{ adId \}, slot, clubId\)/);
    // Paused while the tab is hidden: nobody is looking.
    expect(ROTATOR).toMatch(/document\.visibilityState !== 'visible'/);
  });

  it('a club or sponsor creative is labelled; the house is not', () => {
    expect(SERVICE).toMatch(/advertiserKind: 'house' \| 'club' \| 'sponsor'/);
    // An unknown kind off the wire is never treated as the house.
    expect(SERVICE).toMatch(/return v === 'house' \|\| v === 'club' \? v : 'sponsor';/);
    expect(ROTATOR).toMatch(
      /ad\.advertiserKind === 'club' \? 'Club' : ad\.advertiserKind === 'sponsor' \? 'Sponsored' : null/
    );
  });
});

describe('impressions are counted honestly', () => {
  it('de-duplicates per page load rather than per render', () => {
    /* The strip rotates every 7s and re-renders constantly. Counting renders
       would divide every campaign's click-through rate by a meaningless
       number. */
    expect(SERVICE).toMatch(/seenThisLoad/);
    expect(SERVICE).toMatch(/logImpression/);
  });

  it('the rotator logs the impression for the creative on screen, once per load', () => {
    expect(ROTATOR).toMatch(/AdService\.logImpression\(\{ adId \}, slot, clubId\)/);
    expect(SERVICE).toMatch(/const key = `\$\{ad\.adId\}:\$\{slot\}:viewable`;/);
  });

  it('logs the click BEFORE navigating away', () => {
    const activate = ROTATOR.slice(
      ROTATOR.indexOf('const activate = () => {'),
      ROTATOR.indexOf('const ratio =')
    );
    expect(activate.indexOf('logClick')).toBeGreaterThan(-1);
    expect(activate.indexOf('logClick')).toBeLessThan(activate.indexOf('onNavigate'));
  });
});

describe('a write that changed nothing never reports success', () => {
  /* Caught by the World Hub Silent Write Guard on the first push of this
     feature, naming both lines. PostgREST answers a zero-row match with
     { error: null }, so a PATCH against an ad deleted in another tab would
     have reported "Saved" and changed nothing. */
  it('the panel does not claim an ad is live when placement failed', () => {
    const save = ADMIN.slice(ADMIN.indexOf('const handleSave'), ADMIN.indexOf('// ── Delete'));
    expect(save).toMatch(/created\.placed === false/);
    // The warning must reach the eye, not the cheerful banner.
    const warnBranch = save.slice(save.indexOf('created.placed === false'));
    expect(warnBranch.indexOf('setActionError')).toBeLessThan(
      warnBranch.indexOf('setNotice(editingId')
    );
  });
});

describe('the admin panel is platform staff only, and fails closed', () => {
  it('gates on the platform role, not club membership', () => {
    /* UPDATED 2026-09-02 with the change it pins. This required the literal
       `['admin', 'super_admin']`, which was the bug rather than the contract:
       the database authority (`fn_is_platform_admin()`) answers
       `role IN ('admin','superadmin','god')`, production holds `god` on 2
       accounts and `super_admin` on none, so this page hid House Ads from the
       two most privileged accounts on the platform while the database let
       them call the admin RPCs. The shared predicate is now the single
       vocabulary — see src/utils/platformRoles.ts and
       tests/unit/platformRoles.test.ts, which pins the role list itself. */
    expect(ADMIN).toMatch(/isPlatformStaffRole\(/);
    expect(ADMIN).toMatch(/from '\.\.\/\.\.\/utils\/platformRoles'/);
  });

  it('treats an unreadable role as NOT allowed', () => {
    const check = ADMIN.slice(ADMIN.indexOf('HouseAdsPage.checkRole'), ADMIN.indexOf('// ── Load'));
    expect(check).toMatch(/setAllowed\(false\)/);
  });

  it('renders a dash, never a zero, when performance could not be read', () => {
    /* A confident zero reads as "this campaign got no clicks" when the truth
       is "we could not count" — the exact class of lie the cashier and lobby
       audits kept finding. */
    expect(ADMIN).toMatch(/stats === null \? '-'/);
    expect(ADMIN).toMatch(/Could Not Be Read/i);
  });
});

describe('the frequency cap belongs to one surface, and its refusals are countable', () => {
  /* 2026-08-28. The World Hub ad surface shipped, deployed, and rendered
     nothing. Two independently written Hub clients both showed an empty
     surface while the Club Arena lobby kept serving normally.

     The cap subquery counted a player's impressions of a campaign across
     EVERY slot, while `daily_cap` is a property of one placement on one
     surface. The account that found it had 36 lobby impressions of
     spins_jackpot and 24 of bbj_running; every hub_promotions placement caps
     at 2 or 3, so all of them were over cap before the Hub had shown a single
     advert. `fn_resolve_ads('hub_promotions')` returned 3 rows as postgres
     and 0 as the authenticated player.

     Left alone, every future slot inherits a cap an active player has already
     spent somewhere else. This is PR #1505 in a different costume: a
     suppression rule whose every refusal was silent and therefore
     indistinguishable from "no campaigns are running". */

  it('scopes the cap to the placement own slot', () => {
    const cap = CAP_MIGRATION.slice(
      CAP_MIGRATION.indexOf('Frequency cap, PER SURFACE'),
      CAP_MIGRATION.indexOf('ORDER BY c.weight DESC')
    );
    expect(cap).toMatch(/AND e\.slot = pl\.slot/);
    expect(cap).toMatch(/e\.event_type = 'impression'/);
  });

  it('ships a way to tell "capped" apart from "nothing is running"', () => {
    /* Dan 2026-08-28: "if you add a cap or a hold, make it rotate, and make a
       suppressed ad countable." The rolling 24h window is the rotating half.
       This is the countable half, and it was the part that was missing.

       The first attempt (fn_ad_cap_status) counted the CALLER'S own
       impressions, which is the right unit for a player debugging their own
       screen and useless to the only person who asks - this panel is
       staff-only. It was never wired, and 20260828055000 replaced it with
       fn_ad_suppression, which counts people. The pin follows the answer, not
       the first attempt at it. */
    expect(CAP_MIGRATION).toMatch(/suppressed ad countable/);
    expect(SUPPRESSION_MIGRATION).toMatch(/create or replace function public\.fn_ad_suppression/);
    expect(SUPPRESSION_MIGRATION).toMatch(/served_users_24h/);
    expect(SUPPRESSION_MIGRATION).toMatch(/capped_users_24h/);
  });

  it('asserts the regression itself rather than describing it', () => {
    /* A migration that only says what it fixes cannot fail when it does not.
       This one aborts if the busiest lobby reader still has no eligible
       hub_promotions placement. */
    expect(CAP_MIGRATION).toMatch(/the cap is still leaking across surfaces/);
    expect(CAP_MIGRATION).toMatch(/raise exception/i);
  });

  it('keeps VIP suppression absent, in both directions', () => {
    // Dan 2026-08-27: "even vips will see ads remove that for now."
    const body = CAP_MIGRATION.slice(CAP_MIGRATION.indexOf('RETURN QUERY'));
    expect(body).not.toMatch(/NOT v_vip[\s\S]{0,40}AND NOT/);
    // The quote is wrapped across a comment line break in the migration, so
    // the gap is part of the pattern rather than something to normalise away.
    expect(CAP_MIGRATION).toMatch(/even vips will[\s\S]{0,12}see ads/i);
  });
});

describe('an ad destination is resolved by the server, never by a template a client must expand', () => {
  /* 2026-08-28 03:32 UTC, observed in production. ad_catalog.target_url was
     changed to carry `{clubId}`, to be substituted by the Club Arena client.
     The data change went live; the client that understands it had not shipped.
     A real click on the lobby strip landed on
     /hub/club-arena/invite/%7BclubId%7D -- the literal placeholder -- and the
     page said "Club not found or invitation expired".

     Three clients across two repos and two deploy pipelines read this column.
     A placeholder only one of them expands is a literal string in the other
     two, and every future slot inherits the same trap. */
  const TEMPLATE_MIGRATION = read(
    'supabase/migrations/20260828034000_ad_destination_template_is_resolved_server_side.sql'
  );

  it('substitutes the club the resolver was already handed', () => {
    expect(TEMPLATE_MIGRATION).toMatch(/replace\(/);
    expect(TEMPLATE_MIGRATION).toMatch(/'\{clubId\}'/);
    expect(TEMPLATE_MIGRATION).toMatch(/p_club_id::text/);
  });

  it('refuses to serve a destination it could not resolve', () => {
    /* No club in context means the placeholder cannot be honoured. Showing one
       advert fewer beats sending a player to an error page. */
    expect(TEMPLATE_MIGRATION).toMatch(/r\.target_url NOT LIKE '%\{%'/);
  });

  it('does not lose the per-surface cap while rewriting the resolver', () => {
    // The previous migration's fix has to survive every later CREATE OR REPLACE.
    expect(TEMPLATE_MIGRATION).toMatch(/AND e\.slot = pl\.slot/);
    expect(TEMPLATE_MIGRATION).toMatch(/the per-surface frequency cap was lost in this rewrite/);
  });
});

describe('the last two Club Arena slots are wired, and only where they earn it', () => {
  /* Phase 1 declared five slots and wired one. `empty_state` and
     `session_summary` had never carried a single placement row: the CHECK
     permitted them, the resolver served them, and nothing ever named them. A
     slot with no inventory renders nothing, which is indistinguishable from a
     slot nobody ever built. */
  const CARD = read('src/components/ads/HouseAdCard.tsx');
  const LOBBY_PAGE = read('src/pages/ClubHomePage.tsx');
  const SESSION = read('src/components/session/SessionSummaryHost.tsx');
  const SLOTS_MIGRATION = read(
    'supabase/migrations/20260828040000_house_ads_empty_state_and_session_summary.sql'
  );

  it('the empty state still renders the card; the session summary moved to pictures', () => {
    // The house bug shape: a component that exists and nothing imports.
    expect(LOBBY_PAGE).toMatch(/import HouseAdCard from '\.\.\/components\/ads\/HouseAdCard'/);
    expect(LOBBY_PAGE).toMatch(/<HouseAdCard\s+slot="empty_state"/);
    expect(SESSION).not.toMatch(/HouseAdCard/);
    expect(SESSION).toMatch(/<HouseAdRotator[\s\n]+slot="session_summary"/);
  });

  it('empty_state appears only where the player has nothing to tap', () => {
    /* The lobby has four empty views. Three carry a remedy ("Show All Games"),
       and an advert beside a fix competes with the fix. Only the branch where
       the club is genuinely running nothing is dead space. */
    const emptyBlock = LOBBY_PAGE.slice(
      LOBBY_PAGE.indexOf("'No Tournaments Yet' : 'No Tables Yet'"),
      LOBBY_PAGE.indexOf('Nothing On This Tab Right Now')
    );
    expect(emptyBlock).toMatch(/<HouseAdCard/);
    // And nowhere else in the page.
    expect(LOBBY_PAGE.match(/<HouseAdCard/g)?.length).toBe(1);
  });

  it('the card logs the click before it navigates', () => {
    const activate = CARD.slice(CARD.indexOf('const activate'), CARD.indexOf('const inner'));
    expect(activate.indexOf('AdService.logClick')).toBeGreaterThan(-1);
    expect(activate.indexOf('AdService.logClick')).toBeLessThan(activate.indexOf('onNavigate?.'));
  });

  it('the card decides nothing about who is eligible', () => {
    const code = CARD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/is_?[Vv]ip/);
    expect(code).not.toMatch(/audience/);
    expect(code).not.toMatch(/profitLoss/);
  });

  it('is not activatable when there is nowhere SAFE to go', () => {
    /* Without this the card was still focusable, still showed a pointer, and
       did nothing when tapped - the same defect the lobby strip had.

       2026-08-28: the condition was `Boolean(ad.targetUrl)`, i.e. "there is a
       string in the column". `target_url` is free text typed into the admin
       panel, so that made the whole card a link to wherever it pointed -
       including off-site. The rule is now "there is a string AND it is a
       rooted same-origin path" (isSafeAdTarget), which is strictly stronger:
       every destination that used to be activatable and is still safe still
       is. The pin follows the intent rather than the old expression. */
    expect(CARD).toMatch(
      /const activatable = isSafeAdTarget\(ad\.targetUrl\) && Boolean\(onNavigate\)/
    );
    expect(CARD).toMatch(/house-ad--static/);
  });

  it('gives session_summary destinations that do not need a club', () => {
    /* That host lives at the app root and survives the navigate() off the
       table, so it calls the resolver with NULL. A {clubId} destination there
       is dropped by the resolver and the slot looks empty for a reason nobody
       can see. */
    expect(SLOTS_MIGRATION).toMatch(/'tournaments_daily', 'session_summary'[^\n]*'\/tournaments'/);
    expect(SLOTS_MIGRATION).toMatch(
      /session_summary destination\(s\) need a club this surface never has/
    );
  });

  it('does not ask a player who just lost to buy chips', () => {
    /* The one entry that is a judgement rather than a mechanic: roughly half
       the players seeing Session Complete have just lost, and diamonds_store
       is the only house campaign that asks somebody to spend money. Placing it
       there should be Dan's decision, not a side effect of placing everything
       everywhere. */
    const inserts = SLOTS_MIGRATION.slice(
      SLOTS_MIGRATION.indexOf('join (values'),
      SLOTS_MIGRATION.indexOf('as v(ad_key')
    );
    expect(inserts).not.toMatch(/diamonds_store/);
  });
});

describe('the panel can finally say WHICH surface works', () => {
  /* Until 2026-08-28 the rollup was keyed on ad_id alone, which was right when
     one slot existed. bbj_running now runs on four surfaces and reported one
     blended number, so an operator could not tell whether the lobby was
     carrying the campaign or dragging it down - and the obvious action on a
     poor blended number, turning the campaign off, can be exactly wrong. */
  const STATS_MIGRATION = read(
    'supabase/migrations/20260828050000_ad_stats_by_slot_and_a_slot_that_must_be_real.sql'
  );

  it('counts per ad AND per slot', () => {
    expect(STATS_MIGRATION).toMatch(/create or replace function public\.fn_ad_stats/);
    expect(STATS_MIGRATION).toMatch(/GROUP BY e\.ad_id, e\.slot/);
    // A surface that has STOPPED reporting must be as visible as one that
    // never started.
    expect(STATS_MIGRATION).toMatch(/max\(e\.created_at\)\s*AS last_event_at/);
  });

  it('does not let a player read the event log, even in aggregate', () => {
    /* ad_event deliberately has no select policy: one player must never be
       able to enumerate another's viewing history. A SECURITY DEFINER function
       granted to `authenticated` would hand back exactly that. */
    expect(STATS_MIGRATION).toMatch(
      /revoke all on function public\.fn_ad_stats\(\) from public, anon, authenticated/
    );
    expect(STATS_MIGRATION).toMatch(
      /grant execute on function public\.fn_ad_stats\(\) to service_role/
    );
    expect(STATS_MIGRATION).toMatch(/fn_ad_stats is executable by players/);
  });

  it('constrains ad_event.slot the way ad_placement.slot has always been', () => {
    /* Three clients across two repos write that column by hand. One typo -
       'lobby-strip', a stale constant - and the writes keep succeeding while
       that surface's rollup silently splits in two. Nothing would go red. */
    expect(STATS_MIGRATION).toMatch(/add constraint ad_event_slot_check/);
    expect(STATS_MIGRATION).toMatch(/table_between_hands/);
    // And it must refuse to constrain data it would retroactively reject.
    expect(STATS_MIGRATION).toMatch(/inspect them before constraining/);
  });

  it('the panel shows each placement its own numbers', () => {
    expect(ADMIN).toMatch(/statsBySlot\?\.\[ad\.id\]\?\.\[p\.slot\]/);
    expect(ADMIN).toMatch(/No Views Yet/);
  });

  it('still renders a dash, never a zero, when the breakdown is unreadable', () => {
    const start = ADMIN.indexOf('PER SURFACE, NOT BLENDED');
    expect(start).toBeGreaterThan(-1);
    // Slice forward from the marker: the first `</td>` in the file is many
    // cells earlier, so bounding on it produced an empty string and a test
    // that could only ever fail.
    const cell = ADMIN.slice(start, ADMIN.indexOf('</td>', start));
    expect(cell).toMatch(/statsBySlot === null\s*\?\s*'-'/);
  });

  it('degrades instead of lying when the API is older than the panel', () => {
    /* An older deployment of the route sends no statsBySlot. Rendering an
       empty breakdown would read as "no views on any surface", which is a
       confident zero wearing a new hat. */
    expect(ADMIN).toMatch(/statsBySlot\?: StatsBySlot \| null/);
    expect(ADMIN).toMatch(/setStatsBySlot\(res\.statsBySlot \?\? null\)/);
  });
});

describe('an operator can see WHY a surface is quiet', () => {
  /* Views and clicks say what happened. They cannot say what did not, and a
     silent placement has three completely different causes: no placement, no
     audience match, or everybody already capped out for the day.

     This corrects my own work from earlier the same day. fn_ad_cap_status
     counted the CALLER'S impressions - the right unit for a player debugging
     their own screen, useless in a staff-only panel, and I reported it as
     "now consumed" when nothing called it at all. */
  const SUP = read('supabase/migrations/20260828055000_suppression_countable_by_an_operator.sql');

  it('counts people, not one caller', () => {
    expect(SUP).toMatch(/served_users_24h/);
    expect(SUP).toMatch(/capped_users_24h/);
    expect(SUP).toMatch(/pu\.impressions >= pl\.daily_cap/);
  });

  it('replaces the wrong-unit function rather than leaving both', () => {
    expect(SUP).toMatch(/drop function if exists public\.fn_ad_cap_status\(text\)/);
    expect(SUP).toMatch(/it was meant to be replaced, not duplicated/);
  });

  it('is staff-only, like every other aggregate over ad_event', () => {
    expect(SUP).toMatch(
      /revoke all on function public\.fn_ad_suppression\(\) from public, anon, authenticated/
    );
    expect(SUP).toMatch(/grant execute on function public\.fn_ad_suppression\(\) to service_role/);
  });

  it('returns a row for every active placement, so none is silently skipped', () => {
    expect(SUP).toMatch(/fn_ad_suppression returned % rows for % active placements/);
  });

  it('rebuilds the cap index to match the cap predicate', () => {
    /* idx_ad_event_cap was (user_id, ad_id, created_at). The per-surface fix
       added `AND e.slot = pl.slot` and left the index behind, so slot and
       event_type were filtered after the fetch - on every candidate advert on
       every page load. */
    expect(SUP).toMatch(
      /create index idx_ad_event_cap\s*\n?\s*on public\.ad_event \(user_id, ad_id, slot, event_type, created_at desc\)/
    );
    expect(SUP).toMatch(/idx_ad_event_cap does not cover the cap predicate/);
  });

  it('the panel shows it, and only when somebody is actually capped', () => {
    expect(ADMIN).toMatch(/suppression\?\.\[ad\.id\]\?\.\[p\.slot\]/);
    expect(ADMIN).toMatch(/Capped Out/);
    expect(ADMIN).toMatch(/sup && sup\.cappedUsers24h > 0/);
  });
});

describe('a click is attention, not a result', () => {
  /* Everything measured before today answered "did anyone look at it", which
     was the point and was worth building. It cannot answer the question an
     operator acts on: did the advert work. vip_upsell having clicks says
     nothing about whether anybody subscribed, and the panel showed the same
     two numbers for a campaign converting a third of its clicks and one
     converting none. */
  const CONV = read('supabase/migrations/20260828060000_did_the_advert_actually_work.sql');

  it('asks whether the same player did the thing, inside a window', () => {
    expect(CONV).toMatch(/create or replace function public\.fn_ad_conversions/);
    expect(CONV).toMatch(/p_window_hours integer default 24/);
    expect(CONV).toMatch(/v\.created_at >= k\.created_at/);
  });

  it('names itself after what it measures, not what it would like to prove', () => {
    /* Correlation inside a window is not causation: a player who was going to
       subscribe anyway is counted. So the column is clicks_followed_by, and
       nothing in the file calls it "caused". */
    expect(CONV).toMatch(/clicks_followed_by/);
    /* Strip the SQL comments before the negative assertion. The header
       explains the naming by quoting the phrase it refuses to use, so a search
       over the whole file finds the explanation and fails on it — the same
       trap this suite hit once already on the World Hub side. */
    const sql = CONV.replace(/^\s*--.*$/gm, '');
    expect(sql).not.toMatch(/conversions caused by/i);
    expect(ADMIN).toMatch(/Followed Through/);
    expect(ADMIN).toMatch(/Correlation, Not Proof Of Cause/);
  });

  it('counts a purchase only when it completed', () => {
    // An abandoned checkout is not a purchase, and a started one is not either.
    expect(CONV).toMatch(/d\.completed_at IS NOT NULL/);
  });

  it('returns NULL, never 0, for a campaign with no defined outcome', () => {
    /* bbj_running promotes reading a jackpot page, which is not a database
       event. A confident 0 would read as "converts nobody" when the truth is
       "success is undefined here". Inventing a metric to avoid an empty cell
       is how a reporting system starts lying. */
    expect(CONV).toMatch(/ELSE NULL END AS clicks_followed_by/);
    expect(CONV).toMatch(/bbj_running reported a conversion count/);
    expect(ADMIN).toMatch(/No Outcome Defined/);
  });

  it('asserts its own denominator', () => {
    // If the click count drifts from ad_event, the panel divides by a number
    // that is not the clicks.
    expect(CONV).toMatch(/fn_ad_conversions counted % clicks; ad_event holds %/);
  });

  it('is staff-only, like every other aggregate over ad_event', () => {
    expect(CONV).toMatch(
      /revoke all on function public\.fn_ad_conversions\(integer\) from public, anon, authenticated/
    );
    expect(CONV).toMatch(/it joins ad_event to purchase history/);
  });

  it('does not do arithmetic on nothing', () => {
    // A conversion line under a placement with no clicks says nothing.
    expect(ADMIN).toMatch(/conv && conv\.clicks > 0/);
  });
});

describe('the referral funnel the ads point at does not drop the referral', () => {
  /* referral_invite is one of the six house campaigns, and it points players
     at a share flow that was losing the thing being shared.

     ReferralDashboard handed navigator.share the BARE HOMEPAGE, with the code
     only in `text`. A share target is free to ignore `text` and use `url`
     alone, and most do - every sheet that renders a link preview, and several
     that post the URL and drop the caption. So the commonest way to share a
     referral was also the way that silently dropped it: the friend arrives
     unattributed and the referrer is never credited.

     The other two referral flows already embed the code in the URL, so this
     was the one that leaked, not the pattern. Flagged in the Phase 2 handoff
     on 2026-08-27 and still live a day later. */
  const DASH = read('src/components/social/ReferralDashboard.tsx');

  it('shares a url that carries the code', () => {
    expect(DASH).toMatch(/\?ref=\$\{encodeURIComponent\(stats\.code\)\}/);
    const share = DASH.slice(DASH.indexOf('const handleShare'), DASH.indexOf('if (loading)'));
    expect(share).toMatch(/const url = referralUrl\(\)/);
    expect(share).toMatch(/^\s*url,$/m);
  });

  it('never shares the bare homepage as the destination', () => {
    const code = DASH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/url:\s*'https:\/\/smarter\.poker'/);
  });

  it('does not hardcode the host, so a preview build shares itself', () => {
    // A hardcoded link in a preview build sends testers to production.
    expect(DASH).toMatch(/window\.location\?\.origin/);
  });

  it('the clipboard fallback carries the link too', () => {
    const share = DASH.slice(DASH.indexOf('const handleShare'), DASH.indexOf('if (loading)'));
    expect(share).toMatch(/writeText\(`\$\{shareText\} \$\{url\}`\)/);
  });
});

describe('weight is a share of voice, not a queue position', () => {
  /* fn_resolve_ads ordered by `weight DESC, created_at DESC` from Phase 1.
     That is deterministic: the same player on the same surface got the same
     advert in the same position every time until a cap moved.

     It did not matter while one slot returned six adverts and rotated through
     them client-side. It matters now: empty_state and session_summary are
     single-card surfaces, so the highest-weighted eligible campaign won EVERY
     draw and a campaign with no cap never ran out. A player seeing the surface
     twice a day saw the same two campaigns forever.

     Everywhere else in this industry a weight means "roughly this share of the
     impressions", and the admin panel offers a weight box that quietly meant
     something else. */
  const DRAW = read(
    'supabase/migrations/20260828070000_weight_is_a_share_of_voice_not_a_queue_position.sql'
  );

  it('draws proportionally instead of ranking', () => {
    // Efraimidis-Spirakis: key = random()^(1/weight), take the largest k.
    expect(DRAW).toMatch(/ORDER BY random\(\) \^ \(1\.0 \/ GREATEST\(r\.weight, 1\)\) DESC/);
    expect(DRAW).not.toMatch(/ORDER BY r\.weight DESC/);
  });

  it('guards the exponent, because weight has no CHECK', () => {
    /* A 0 or a negative typed into the panel would divide by zero or invert
       the ordering. 0 now means "vanishingly unlikely", which is the kinder
       reading of what somebody typing 0 probably meant. */
    expect(DRAW).toMatch(/GREATEST\(r\.weight, 1\)/);
  });

  it('is VOLATILE, or the planner undoes the whole change', () => {
    /* A STABLE function may evaluate random() once and reuse it within a
       statement, which is exactly the behaviour this replaces. */
    expect(DRAW).toMatch(/^volatile$/m);
    expect(DRAW).toMatch(/a STABLE function may evaluate random\(\) once and reuse it/);
  });

  it('keeps every rule that is not the ordering', () => {
    /* Each of these has its own migration and its own incident behind it, and
       a CREATE OR REPLACE is where they get silently dropped. */
    expect(DRAW).toMatch(/AND e\.slot = pl\.slot/);
    expect(DRAW).toMatch(/'\{clubId\}'/);
    expect(DRAW).toMatch(/NOT LIKE '%\{%'/);
    expect(DRAW).toMatch(/the per-surface frequency cap was lost in this rewrite/);
    expect(DRAW).toMatch(/the club placeholder substitution was lost in this rewrite/);
    expect(DRAW).toMatch(/the unresolved-placeholder guard was lost in this rewrite/);
  });

  it('proves it varies rather than asserting that it should', () => {
    // Twenty single draws from a six-campaign slot; a deterministic ORDER BY
    // returns the same advert every time.
    expect(DRAW).toMatch(/for i in 1\.\.20 loop/);
    expect(DRAW).toMatch(/all returned the same advert; the draw is not weighted/);
  });
});

describe('impressions are not people, and a subset says so', () => {
  /* fn_ad_stats counted EVENTS. Right for "how often was this shown", wrong
     for almost every question an operator asks, and the two can differ by two
     orders of magnitude with nothing on the panel saying which you are reading.

     Production the day this shipped: spins_jackpot had 65 impressions on
     lobby_strip and FIVE viewers - thirteen views each, because the lobby logs
     one impression per advert per page load and a test account was reloading.
     Read as reach, 65 is a campaign doing well. Five is the truth. */
  const REACH = read('supabase/migrations/20260828080000_impressions_are_not_people.sql');

  it('counts people beside events, not instead of them', () => {
    expect(REACH).toMatch(
      /count\(DISTINCT e\.user_id\) FILTER \(WHERE e\.event_type = 'impression'\) AS viewers/
    );
    expect(REACH).toMatch(
      /count\(DISTINCT e\.user_id\) FILTER \(WHERE e\.event_type = 'click'\)\s+AS clickers/
    );
    // The event counts stay: the ratio between them is frequency.
    expect(REACH).toMatch(/AS impressions/);
    expect(REACH).toMatch(/AS clicks/);
  });

  it('refuses to report more people than events', () => {
    /* If reach ever exceeds frequency the DISTINCT is on the wrong column and
       every ratio built on it is wrong in a way nobody would spot by eye. */
    expect(REACH).toMatch(/viewers > impressions or clickers > clicks/);
    expect(REACH).toMatch(/report more people than events/);
  });

  it('stays staff-only through the rewrite', () => {
    expect(REACH).toMatch(
      /revoke all on function public\.fn_ad_stats\(\) from public, anon, authenticated/
    );
  });

  it('the panel says people, in words, beside the views', () => {
    expect(ADMIN).toMatch(/Views To \$\{ss\.viewers/);
    expect(ADMIN).toMatch(/ss\.viewers === 1 \? 'Person' : 'People'/);
  });

  it('the panel admits when the list it shows is a subset', () => {
    /* The catalog read stops at 200 rows and placements at 1,000. Those limits
       are fine; silently presenting a partial list as the whole one is not -
       the same shape as the 50,000-row stats ceiling that under-counted for as
       long as it existed. */
    expect(ADMIN).toMatch(/Showing Part Of The List Only/);
    expect(ADMIN).toMatch(/truncated && \(truncated\.ads \|\| truncated\.placements\)/);
  });
});

describe('a lifetime total cannot show a campaign decaying', () => {
  /* Every other figure on this page is a lifetime number, so a campaign that
     worked for three weeks and has done nothing since reads the same as one
     working today - the averages absorb the decline, and the longer it runs
     the more inertia its own history gives it. `lastEventAt` catches a surface
     that stopped dead. It says nothing about one quietly halving. */
  const DAILY = read(
    'supabase/migrations/20260828090000_a_campaign_decays_and_nothing_shows_it.sql'
  );

  it('groups by day as well as ad and slot', () => {
    expect(DAILY).toMatch(/create or replace function public\.fn_ad_daily/);
    expect(DAILY).toMatch(/GROUP BY e\.ad_id, e\.slot, \(e\.created_at AT TIME ZONE 'UTC'\)::date/);
  });

  it('clamps the window instead of trusting the caller', () => {
    // A year of daily rows for one campaign is 365. Ten years is a mistake.
    expect(DAILY).toMatch(/GREATEST\(1, LEAST\(COALESCE\(p_days, 30\), 365\)\)/);
  });

  it('checks its own days sum to the lifetime', () => {
    /* If the two disagree, the panel shows a trend that contradicts its own
       totals and there is no way to tell which is lying. */
    expect(DAILY).toMatch(/fn_ad_daily impressions do not sum to ad_event over the same window/);
  });

  it('is staff-only, like every other aggregate over ad_event', () => {
    expect(DAILY).toMatch(
      /revoke all on function public\.fn_ad_daily\(integer\) from public, anon, authenticated/
    );
  });

  it('says why it is computed live rather than rolled up by a cron', () => {
    /* A rollup table is a second source of truth to keep in step, and a new
       scheduled job is a governed change - Open Claw is the only sanctioned
       scheduler. Worth writing down so the next person does not add one
       casually. */
    expect(DAILY).toMatch(/Open\s*\n?--\s*Claw is the only sanctioned scheduler/);
  });

  it('the panel draws it, and refuses to draw a trend from one day', () => {
    // A single bar is not a trend, it is a number wearing one.
    expect(ADMIN).toMatch(/const sparkline = \(values: number\[\]\)/);
    expect(ADMIN).toMatch(/series && series\.length > 1/);
  });
});

describe('two things the panel had been assuming about the catalog', () => {
  const DAILY = read(
    'supabase/migrations/20260828090000_a_campaign_decays_and_nothing_shows_it.sql'
  );

  it('a weight must be a positive number', () => {
    /* Weight became the share of voice, and the draw guards the exponent with
       GREATEST(weight, 1) because a 0 would divide by zero. That guard is
       right and stays - but the database should not silently reinterpret what
       somebody typed into a free-text box. A weight of 0 is a mistake, and the
       save should say so where it happens. */
    expect(DAILY).toMatch(/add constraint ad_catalog_weight_positive check \(weight > 0\)/);
  });

  it('a flight window cannot end before it begins', () => {
    /* starts_at <= now() AND ends_at > now() can never both hold, so such a
       campaign is live in the editor and dead everywhere else - the exact
       silent-nothing this system keeps finding. */
    expect(DAILY).toMatch(/add constraint ad_catalog_flight_window_ordered/);
    expect(DAILY).toMatch(/ends_at > starts_at/);
  });

  it('refuses to constrain data it would retroactively reject', () => {
    expect(DAILY).toMatch(/decide what they should be before constraining/);
    expect(DAILY).toMatch(/those are live and dead at once, fix them before constraining/);
  });
});

describe('a placement can be managed, not only born', () => {
  /* POST created the advert plus exactly ONE placement, and PATCH never
     touched ad_placement at all. So the panel could make a campaign live on
     one surface and then never move it: no second surface, no cap change, no
     pausing one surface while another kept running. Every one of the eighteen
     multi-slot placements in production was written by an agent, in a
     migration, and the per-placement reporting shipped earlier the same day
     described a dimension the editor could not manage. */
  const PLACEMENT_MIGRATION = read(
    'supabase/migrations/20260828100000_placements_images_experiments_and_retention.sql'
  );

  it('the panel can open, add, edit, pause and remove a placement', () => {
    expect(ADMIN).toMatch(/const savePlacement = async/);
    expect(ADMIN).toMatch(/const togglePlacement = async/);
    expect(ADMIN).toMatch(/const removePlacement = async/);
    expect(ADMIN).toMatch(/query: \{ kind: 'placement' \}/);
    // And it is reachable: a handler nothing calls is the house bug shape.
    expect(ADMIN).toMatch(/onClick=\{\(\) => openPlacements\(ad\.id\)\}/);
    expect(ADMIN).toMatch(/onClick=\{\(\) => editPlacement\(p\)\}/);
    expect(ADMIN).toMatch(/onClick=\{\(\) => togglePlacement\(p\)\}/);
    expect(ADMIN).toMatch(/onClick=\{\(\) => removePlacement\(p, ad\.headline\)\}/);
  });

  it('says so when a removal leaves the campaign running nowhere', () => {
    /* An ad with no placement runs nowhere and looks perfectly healthy in the
       list - the commonest way to publish something and see nothing happen. */
    expect(ADMIN).toMatch(/That Ad Now Runs Nowhere/);
    expect(ADMIN).toMatch(/Not Placed\. This Ad Is Running Nowhere\./);
  });

  it('a placement club must be a real club', () => {
    /* club_id has been honoured by the resolver since Phase 1 and is NULL on
       every row, which is exactly the state in which a typo goes unnoticed.
       Now the panel can write it, so the database has to mean it. */
    expect(PLACEMENT_MIGRATION).toMatch(/add constraint ad_placement_club_fk/);
    expect(PLACEMENT_MIGRATION).toMatch(/references public\.clubs\(id\)/);
  });
});

describe('an ad image is a URL every browser fetches without being asked', () => {
  const PLACEMENT_MIGRATION = read(
    'supabase/migrations/20260828100000_placements_images_experiments_and_retention.sql'
  );
  const CARD = read('src/components/ads/HouseAdCard.tsx');

  it('is checked in the database, and again where it renders', () => {
    /* A destination is checked before a browser is sent to it; an image is the
       same question with LESS consent, because the fetch happens on render. An
       external host hands every player's IP and user agent to a third party
       chosen by whoever typed the URL into the panel. */
    expect(PLACEMENT_MIGRATION).toMatch(/add constraint ad_catalog_image_is_same_origin/);
    expect(PLACEMENT_MIGRATION).toMatch(/image_url like '\/%' and image_url not like '\/\/%'/);
    expect(SERVICE).toMatch(/export function isSafeAdImage/);
    expect(CARD).toMatch(/isSafeAdImage\(ad\.imageUrl\)/);
  });

  it('proves the constraint refuses an external URL rather than trusting it', () => {
    // Probed inside the migration and rolled back, not asserted by reading.
    expect(PLACEMENT_MIGRATION).toMatch(/the image origin constraint accepted an external URL/);
    expect(PLACEMENT_MIGRATION).toMatch(/when check_violation then null/);
  });

  it('falls back to the glyph when the file is missing', () => {
    // A broken-image icon in a promotion is worse than no promotion.
    expect(CARD).toMatch(/onError=\{\(\) => setImageFailed\(true\)\}/);
    expect(CARD).toMatch(/showImage \? \(/);
  });
});

describe('two creatives can be known to be one test', () => {
  const PLACEMENT_MIGRATION = read(
    'supabase/migrations/20260828100000_placements_images_experiments_and_retention.sql'
  );

  it('experiment_key names the relationship the draw already honours', () => {
    /* Nothing stopped somebody creating two catalog rows, and since the
       weighted draw landed the traffic would split correctly - but the panel
       reported them as unrelated campaigns, so nobody could read the result. */
    expect(PLACEMENT_MIGRATION).toMatch(/add column if not exists experiment_key text/);
    expect(ADMIN).toMatch(/experiment_key/);
    expect(ADMIN).toMatch(/Variants Of One Test/i);
  });
});

describe('ad_event does not grow forever, and pruning is a policy', () => {
  const PLACEMENT_MIGRATION = read(
    'supabase/migrations/20260828100000_placements_images_experiments_and_retention.sql'
  );

  it('reads its window from a policy row rather than a hardcoded number', () => {
    /* ad_event is the denominator of every number this panel prints, so
       pruning it changes history and belongs in a policy somebody set. */
    expect(PLACEMENT_MIGRATION).toMatch(
      /create table if not exists public\.ad_event_retention_policy/
    );
    expect(PLACEMENT_MIGRATION).toMatch(/create or replace function public\.fn_prune_ad_events/);
  });

  it('refuses to prune when there is no policy at all', () => {
    // No policy row is not permission to delete everything.
    expect(PLACEMENT_MIGRATION).toMatch(/ad_event_retention_policy has no row; refusing to prune/);
  });

  it('is not scheduled here, and says why', () => {
    /* Open Claw is the only sanctioned scheduler and a new cron is a governed
       change; CI also fails on a net-new file in pages/api/cron/. Wiring this
       to a schedule needs a paper trail, not a side effect of a migration. */
    expect(PLACEMENT_MIGRATION).toMatch(/IT IS NOT SCHEDULED HERE/);
    expect(PLACEMENT_MIGRATION).toMatch(/Open Claw the only sanctioned scheduler/);
  });
});

describe('a NULL club is a value, not a wildcard', () => {
  /* ad_placement's unique key was UNIQUE (ad_id, slot, club_id) from Phase 1.
     Postgres treats NULLs as DISTINCT by default, and club_id is NULL on every
     one of the eighteen placements in production because NULL is how "every
     club" is spelled - so the key had never fired for a single real row.

     It did not matter while the only writer was a hand-written migration under
     review. It mattered the moment the panel could add placements: two clicks
     of Add Placement on one surface would have rendered the advert twice from
     one JOIN, split its cap in two, and returned a cheerful success from an
     API branch that could never fire.

     Found by PROBING the key rather than reading it. Reading it is how it
     passed review in the first place. */
  const KEY = read('supabase/migrations/20260828110000_a_null_club_is_a_value_not_a_wildcard.sql');

  it('replaces the key with one that counts NULL as a value', () => {
    expect(KEY).toMatch(/unique nulls not distinct \(ad_id, slot, club_id\)/);
    expect(KEY).toMatch(/drop constraint if exists ad_placement_ad_id_slot_club_id_key/);
  });

  it('proves the new key refuses what the old one accepted', () => {
    // Asserted by inserting a duplicate and expecting the violation, rolled
    // back inside the migration.
    expect(KEY).toMatch(/still accepts a duplicate platform-wide placement/);
    expect(KEY).toMatch(/when unique_violation then null/);
  });

  it('refuses to tighten the key over data that would fail it', () => {
    expect(KEY).toMatch(/resolve them before tightening the key/);
  });
});

describe('retention is reachable, and shows its blast radius first', () => {
  /* fn_prune_ad_events shipped in 20260828100000 with NO CALLER anywhere: a
     permanent delete that could not be scheduled (CLAUDE.md 11 makes Open Claw
     the only sanctioned scheduler, and 11.3 fails CI on a net-new cron route)
     and could not be reached. Dead code on a DELETE is worse than dead code. */
  const page = readFileSync(resolve(__dirname, '../../src/pages/admin/HouseAdsPage.tsx'), 'utf8');

  it('calls the prune route, so the function is no longer unreachable', () => {
    expect(page).toMatch(/kind: 'prune'/);
    expect(page).toMatch(/const pruneEvents = async/);
    // And the handler is actually bound to something clickable.
    expect(page).toMatch(/onClick=\{\(\) => void pruneEvents\(\)\}/);
  });

  it('states the count before the delete, and puts it on the button', () => {
    /* An operator must never learn the size of a permanent delete from its
       result. The confirm carries the number and so does the control. */
    expect(page).toMatch(
      /Events Older Than \$\{retention\.retentionDays\} Days Will Be Deleted Permanently/
    );
    expect(page).toMatch(/Delete \$\{retention\.prunableEvents\.toLocaleString\(\)\} Events/);
  });

  it('offers no prune control at all when there is nothing to prune', () => {
    /* Not a disabled button. A dead control on a destructive action invites
       the experimental click that finds out what it does. */
    expect(page).toMatch(/retention\.prunableEvents > 0 \?/);
    expect(page).toMatch(/Nothing Past The Cutoff\./);
  });

  it('disarms when the operator backs out', () => {
    // Leaving it armed means the next stray click deletes.
    expect(page).toMatch(/if \(!ok\) \{\s*setPruneArmed\(false\);\s*return;\s*\}/);
  });

  it('sends no day count, so the preview and the delete cannot disagree', () => {
    /* The server reads ad_event_retention_policy itself. A "days" parameter on
       the wire would let the number shown at render differ from the number
       used at click. */
    expect(page).not.toMatch(/kind: 'prune'[^}]*days/);
  });
});

describe('a click is only counted when it went somewhere (2026-08-29)', () => {
  /* `target_url` is admin-entered text. Every client already refuses one that
     is not a rooted, same-origin path - but the lobby strip logged the click
     BEFORE it checked, and decided whether to render a button from the raw
     column rather than from the checked destination. So an ad pointing at
     `https://…` rendered as a tappable strip, recorded a click, and went
     nowhere. Those events are worse than no events: in the panel they are
     indistinguishable from a campaign that works, and they inflate the very
     click-through rate an operator uses to choose what to run next. */
  const SUMMARY = read('src/components/session/SessionSummaryHost.tsx');

  it('the rotator substitutes, then validates, the destination before anything else uses it', () => {
    expect(ROTATOR).toMatch(/const target = \(\(\) => \{/);
    expect(ROTATOR).toMatch(/const url = substituteClub\(ad\.targetUrl, clubId\);/);
    expect(ROTATOR).toMatch(/return isSafeAdTarget\(url\) \? url : null;/);
  });

  it('logClick sits inside the branch that has a safe destination', () => {
    const activate = ROTATOR.slice(
      ROTATOR.indexOf('const activate = () => {'),
      ROTATOR.indexOf('const ratio =')
    );
    const guard = activate.indexOf('if (!target || !activatable) return;');
    const log = activate.indexOf('AdService.logClick');
    expect(guard).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(guard);
    // And the raw column is never what the router is handed.
    expect(activate).not.toMatch(/onNavigate\?\.\(ad\.targetUrl/);
    expect(activate).toMatch(/onNavigate\?\.\(target\)/);
  });

  it('a creative with no safe destination is not rendered as a button', () => {
    expect(ROTATOR).toMatch(/const activatable = Boolean\(target\) && Boolean\(onNavigate\);/);
    expect(ROTATOR).toMatch(/ad-rotator__frame--static/);
    expect(ROTATOR).not.toMatch(/activatable =[^;]*Boolean\(ad\.targetUrl\)/);
  });

  it('the card was already right, and stays right', () => {
    const CARD = read('src/components/ads/HouseAdCard.tsx');
    expect(CARD).toMatch(/const activatable = isSafeAdTarget\(ad\.targetUrl\)/);
    const activate = CARD.slice(CARD.indexOf('const activate = () => {'));
    expect(activate.indexOf('if (!activatable) return;')).toBeLessThan(
      activate.indexOf('AdService.logClick')
    );
  });

  it('the session summary closes itself before it routes', () => {
    /* The host is a createPortal overlay that only clearSessionSummary() takes
       down, and the card inside it stops propagation, so the backdrop never
       fires. Navigating without closing left Session Complete covering the
       page the player had just been sent to - with the click already logged. */
    expect(SUMMARY).toMatch(/onNavigate=\{\(path\) => \{\s*close\(\);\s*navigate\(path\);\s*\}\}/);
  });
});

describe('the weight box cannot ask for a weight the database refuses', () => {
  it('the panel floors weight at 1, matching ad_catalog_weight_positive', () => {
    /* PATCH already clamped to 1 and said why. Create clamped to 0, and the
       input allowed 0, so a cleared field (Number('') === 0) came back as
       "Could not create that ad" without ever naming the field. */
    const weightInput = ADMIN.slice(ADMIN.indexOf('id="ad-weight"'), ADMIN.indexOf('max={1000}'));
    expect(weightInput).toMatch(/min=\{1\}/);
    expect(weightInput).not.toMatch(/min=\{0\}/);
  });
});

describe('the destructive dialog reads like every other dialog on the page', () => {
  it('the delete confirm is Title Case, as CLAUDE.md 5.7 requires', () => {
    /* The two other dialogs on this page already were. The one that was not
       is the only one that deletes an ad and its whole history. */
    expect(ADMIN).toMatch(/And Its Performance History Will Be Removed\. This Cannot Be Undone\./);
    expect(ADMIN).not.toMatch(/and its performance history will be removed/);
  });
});

describe('the panel can edit the destination the surface is actually serving', () => {
  /* fn_resolve_ads serves COALESCE(pl.target_url, c.target_url). Eight live
     placements carried an override - every hub_promotions row and both
     session_summary rows - and this panel neither read the column nor wrote
     it. So editing "Links To" on the campaign reported "Saved." and changed
     nothing on those surfaces: a control that lies about what it did, which is
     the failure shape readSlot and the Silent Write Guard both exist to end. */
  it('the placement row carries the override', () => {
    const rowType = ADMIN.slice(
      ADMIN.indexOf('interface PlacementRow'),
      ADMIN.indexOf('type StatRow')
    );
    expect(rowType).toMatch(/target_url: string \| null;/);
  });

  it('shows it in the table, and says what blank means', () => {
    expect(ADMIN).toMatch(/<th>Links To<\/th>/);
    expect(ADMIN).toMatch(/Inherited From The Ad/);
  });

  it('loads the current value into the draft when editing', () => {
    const edit = ADMIN.slice(
      ADMIN.indexOf('const editPlacement'),
      ADMIN.indexOf('const savePlacement')
    );
    expect(edit).toMatch(/target_url: p\.target_url \|\| '',/);
  });

  it('sends the field even when empty, because empty is an instruction', () => {
    /* The server keys on `!== undefined`: omitting it means "leave it alone",
       an empty string means "clear the override and fall back to the ad's own
       destination". An operator who empties the box means the second. */
    const save = ADMIN.slice(
      ADMIN.indexOf('const savePlacement'),
      ADMIN.indexOf('const togglePlacement')
    );
    expect(save).toMatch(/target_url: placementDraft\.target_url,/);
    expect(save).not.toMatch(/target_url: placementDraft\.target_url \|\|/);
  });

  it('the actions column header is named rather than empty', () => {
    // A header cell with no text is a column a screen reader announces as
    // nothing at all.
    expect(ADMIN).toMatch(/<th aria-label="Actions" \/>/);
  });
});
