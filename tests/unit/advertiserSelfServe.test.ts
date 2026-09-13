/**
 * A SPONSOR OWNS THEIR OWN FLIGHTS, AND EVERY FLIGHT HAS A POSTER (2026-09-13)
 *
 * Dan 2026-09-03: "allow others to advertise with us." Dan 2026-09-13: every
 * advert is a fluid picture and a tap opens it full screen. These pins hold
 * the two together: a signed-in sponsor books their own flight into the same
 * review queue a club uses, uploads only into their own folder, reads only
 * their own numbers, is never charged diamonds, and every self-serve flight -
 * club or sponsor - carries the 3:4 poster the popup shows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION = read(
  'supabase/migrations/20260913193627_a_sponsor_owns_their_own_flights_and_every_flight_has_a_post.sql'
);
const SERVICE = read('src/services/AdCampaignService.ts');
const PAGE = read('src/pages/ClubAdvertisePage.tsx');
const PAGE_CSS = read('src/pages/ClubAdvertisePage.css');
const QUEUE = read('src/components/ads/CampaignQueue.tsx');
const APP = read('src/App.tsx');

describe('a sponsor signs in and owns their flights', () => {
  it('one self-serve sponsor per account, held by the database', () => {
    expect(MIGRATION).toMatch(/add column if not exists self_serve boolean not null default false/);
    expect(MIGRATION).toMatch(
      /create unique index if not exists ad_advertiser_one_self_serve_sponsor_per_owner[\s\S]*?where kind = 'sponsor' and self_serve/
    );
    expect(MIGRATION).toMatch(
      /on conflict \(owner_user_id\) where kind = 'sponsor' and self_serve/
    );
    // Staff-typed sponsors are not silently turned self-serve.
    expect(MIGRATION).toMatch(/existing sponsors read as self-serve; expected 0/);
  });

  it('the owner uploads only into their own folder, and the RPC refuses a path outside it', () => {
    const policy = MIGRATION.slice(
      MIGRATION.indexOf('create policy "ad creatives sponsor owner insert"'),
      MIGRATION.indexOf('-- 4.')
    );
    expect(policy).toMatch(/\(storage\.foldername\(name\)\)\[1\] = 'sponsor'/);
    expect(policy).toMatch(/a\.owner_user_id = auth\.uid\(\)/);
    expect(policy).toMatch(/a\.kind = 'sponsor' and a\.self_serve/);
    expect(policy).toMatch(/a\.status = 'active'/);
    const submit = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.fn_sponsor_ad_submit'),
      MIGRATION.indexOf('-- 5.')
    );
    expect(submit).toMatch(
      /v_folder := '\/ad-creatives\/sponsor\/' \|\| v_adv\.id::text \|\| '\/'/
    );
    expect(submit).toMatch(
      /p_image_url not like \(v_folder \|\| '%'\)[\s\S]*?creative_not_in_your_folder/
    );
    expect(submit).toMatch(
      /p_poster_url is null or p_poster_url not like \(v_folder \|\| '%'\)[\s\S]*?poster_not_in_your_folder/
    );
    // Same queue, same priority as a staff-typed sponsor, never charged.
    expect(submit).toMatch(/'submitted', 'platform', 90,/);
    expect(submit).toMatch(/\n\s+0, v_user, p_external_url, p_pacing, p_goal_impressions\)/);
    expect(submit).not.toMatch(/deduct_diamonds/);
    // The surface nothing renders cannot be booked.
    expect(submit).toMatch(/p_slot = 'table_between_hands'/);
    // https only, checked the same way the campaign CHECK does.
    expect(submit).toMatch(/p_external_url !~ '\^https:\/\/\[a-zA-Z0-9\]'/);
  });

  it('a sponsor reads only their own flights and their own numbers', () => {
    const list = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.fn_sponsor_campaign_list'),
      MIGRATION.indexOf('-- 6.')
    );
    expect(list).toMatch(
      /where adv\.kind = 'sponsor' and adv\.self_serve and adv\.owner_user_id = auth\.uid\(\)/
    );
    const report = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.fn_ad_campaign_report'),
      MIGRATION.indexOf('-- 7.')
    );
    expect(report).toMatch(
      /or \(adv\.owner_user_id is not null and adv\.owner_user_id = auth\.uid\(\)\)/
    );
    // The staff and club-staff clauses it had are still there.
    expect(report).toMatch(/public\.fn_is_platform_admin\(\)/);
    expect(report).toMatch(/public\.fn_club_is_staff\(c\.club_id, auth\.uid\(\)\)/);
    // Nothing anonymous.
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_sponsor_campaign_list\(\) from public, anon;/
    );
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_sponsor_ad_submit\([^)]*\) from public, anon;/
    );
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_sponsor_advertiser_upsert\(text, text\) from public, anon;/
    );
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_sponsor_advertiser_mine\(\) from public, anon;/
    );
  });

  it('a sponsor withdraws an unreviewed flight without a refund, a club is still refunded', () => {
    const cancel = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function public.fn_club_ad_cancel'),
      MIGRATION.indexOf('-- 8.')
    );
    expect(cancel).toMatch(/if v_c\.club_id is not null then[\s\S]*?fn_club_is_staff/);
    expect(cancel).toMatch(/not_the_advertiser/);
    expect(cancel).toMatch(/if v_c\.diamonds_charged > 0 then[\s\S]*?add_diamonds_to_balance/);
  });
});

describe('every self-serve flight carries the poster the popup shows', () => {
  it('both submit RPCs take a poster, checked in the same folder as the creative, with one overload each', () => {
    expect(MIGRATION).toMatch(
      /drop function if exists public\.fn_club_ad_submit\(uuid, text, text, text, text, timestamptz, integer, text\);/
    );
    expect(MIGRATION).toMatch(/p_scope text default 'platform',\s*p_poster_url text default null/);
    expect(MIGRATION).toMatch(
      /p_poster_url not like \('\/ad-creatives\/club\/' \|\| p_club_id::text \|\| '\/%'\)[\s\S]*?poster_not_in_club_folder/
    );
    expect(MIGRATION).toMatch(
      /drop function if exists public\.fn_sponsor_campaign_create\(text, text, text, text, text, timestamptz, integer, text, integer, text\);/
    );
    expect(MIGRATION).toMatch(/p_pacing text default 'even',\s*p_poster_url text default null/);
    expect(MIGRATION).toMatch(/fn_club_ad_submit has % overloads/);
    expect(MIGRATION).toMatch(/fn_sponsor_campaign_create has % overloads/);
  });

  it('the service sends the poster on every path and uploads it at 3:4', () => {
    expect(SERVICE).toMatch(
      // Whitespace-tolerant: Prettier breaks the object across lines.
      /export const POSTER_SHAPE = \{\s*width: 1080,\s*height: 1440,\s*label: 'Poster',\s*maxBytes: 614400,?\s*\} as const;/
    );
    expect(SERVICE).toMatch(/p_poster_url: input\.posterUrl,/);
    expect(SERVICE).toMatch(/p_poster_url: input\.posterUrl \?\? null,/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_ad_submit'/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_campaign_list'\)/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_advertiser_mine'\)/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_advertiser_upsert'/);
    // A sponsor's creatives land in the sponsor folder, never a club's.
    expect(SERVICE).toMatch(/uploadTo\(`sponsor\/\$\{advertiserId\}`, slot, file/);
  });

  it('the page will not submit without both pictures, in either mode', () => {
    const can = PAGE.slice(
      PAGE.indexOf('const canSubmit = Boolean('),
      PAGE.indexOf('const advertiserFormOk')
    );
    expect(can).toMatch(/file &&/);
    expect(can).toMatch(/poster &&/);
    expect(can).toMatch(/destinationOk &&/);
    expect(can).toMatch(/advertiserOk &&/);
    expect(PAGE).toMatch(/AdCampaignService\.uploadPoster\(clubId, poster\)/);
    expect(PAGE).toMatch(
      /AdCampaignService\.sponsorUploadPoster\(advertiser\.advertiserId, poster\)/
    );
    expect(PAGE).toMatch(/style=\{\{ aspectRatio: POSTER_RATIO \}\}/);
    expect(PAGE_CSS).toMatch(/\.club-advertise__preview--poster \{/);
  });

  it('the staff sponsor form carries a poster path too', () => {
    expect(QUEUE).toMatch(/posterUrl: sponsor\.posterUrl\.trim\(\) \|\| null,/);
    expect(QUEUE).toMatch(/Poster Path \(3 By 4, Optional\)/);
  });
});

describe('one page, two modes, one dress', () => {
  it('the sponsor door is a shell route with no club in the path, and the club door is unchanged', () => {
    expect(APP).toMatch(/path="advertise"[\s\S]*?<ClubAdvertisePage mode="sponsor" \/>/);
    expect(APP).toMatch(/path="clubs\/:clubId\/advertise"[\s\S]*?<ClubAdvertisePage \/>/);
  });

  it('sponsor mode never spends diamonds and never invents a price', () => {
    expect(PAGE).toMatch(
      /const canAfford = sponsorMode \|\| balance === null \? true : balance >= cost;/
    );
    expect(PAGE).toMatch(/Priced On Request/);
    expect(PAGE).toMatch(/Invoiced By Smarter\.Poker After Review\. Nothing Is Charged Here\./);
    // The sponsor's address is checked the way the RPC checks it before it is sent.
    expect(PAGE).toMatch(/\/\^https:\\\/\\\/\[a-zA-Z0-9\]\/\.test\(s\)/);
    // The one surface nothing renders is not offered to a sponsor.
    expect(PAGE).toMatch(/const UNBUILT_SLOTS: AdSlot\[\] = \['table_between_hands'\];/);
  });

  it("the day-by-day report is the advertiser's to open, and an unreadable one says so", () => {
    expect(PAGE).toMatch(/AdCampaignService\.report\(c\.id\)/);
    expect(PAGE).toMatch(/The Day By Day Numbers Could Not Be Read/);
    expect(PAGE).toMatch(/className="club-advertise__days"/);
    expect(PAGE_CSS).toMatch(/\.club-advertise__days \{/);
  });
});
