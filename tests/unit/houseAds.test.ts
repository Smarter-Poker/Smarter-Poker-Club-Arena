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
const STRIP = read('src/components/lobby/LobbyAdStrip.tsx');
const ADMIN = read('src/pages/admin/HouseAdsPage.tsx');
const CAP_MIGRATION = read('supabase/migrations/20260828032000_ad_cap_is_per_surface.sql');

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

describe('house ads never outrank a club speaking to its own players', () => {
  it('sorts HOUSE last in the merged strip', () => {
    const merged = STRIP.slice(
      STRIP.indexOf('const merged = ['),
      STRIP.indexOf('.slice(0, MAX_ADS)')
    );
    const club = merged.indexOf('clubAds.filter((a) => a.pinned)');
    const union = merged.indexOf('...unionAds');
    const house = merged.indexOf('...houseLobbyAds');
    expect(club).toBeGreaterThan(-1);
    expect(house).toBeGreaterThan(union);
    expect(union).toBeGreaterThan(club);
  });

  it('keeps the three sources labelled rather than merged anonymously', () => {
    expect(STRIP).toMatch(/'CLUB' \| 'UNION' \| 'HOUSE'/);
    expect(STRIP).toMatch(/lobby-ads__tag/);
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

  it('only tracks HOUSE ads, not a club or union announcement', () => {
    expect(STRIP).toMatch(/visibleAd\?\.source === 'HOUSE'/);
  });

  it('logs the click BEFORE navigating away', () => {
    const activate = STRIP.slice(
      STRIP.indexOf('const handleActivate'),
      STRIP.indexOf('const stripClass')
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
    expect(ADMIN).toMatch(/\['admin', 'super_admin'\]/);
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
       This is the countable half, and it was the part that was missing. */
    expect(CAP_MIGRATION).toMatch(/create or replace function public\.fn_ad_cap_status/);
    expect(CAP_MIGRATION).toMatch(/suppressed_by_cap/);
    expect(CAP_MIGRATION).toMatch(
      /grant execute on function public\.fn_ad_cap_status\(text\) to anon, authenticated/
    );
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
