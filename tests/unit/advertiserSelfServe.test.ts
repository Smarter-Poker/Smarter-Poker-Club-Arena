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

  it('sponsor mode never spends diamonds, and shows the price the database will freeze', () => {
    expect(PAGE).toMatch(
      /const canAfford = sponsorMode \|\| balance === null \? true : balance >= cost;/
    );
    expect(PAGE).toMatch(/const quoteCents = rate \? rate\.sponsorCentsPerDay \* days : 0;/);
    expect(PAGE).toMatch(/\{formatDollars\(r\.sponsorCentsPerDay\)\} Per Day/);
    expect(PAGE).toMatch(/Invoiced By Smarter\.Poker Once Approved\. Nothing Is Charged Here\./);
    // A surface with no sponsor price is not offered.
    expect(PAGE).toMatch(/r\.sponsorCentsPerDay > 0/);
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

describe('a sponsor is quoted a price in dollars (2026-09-13)', () => {
  const PRICE = read(
    'supabase/migrations/20260913235536_a_sponsor_is_quoted_a_price_in_dollars.sql'
  );

  it('the price is derived, whole dollars, twice the club rate, and the migration proves it', () => {
    expect(PRICE).toMatch(
      /add column if not exists sponsor_cents_per_day integer not null default 0/
    );
    expect(PRICE).toMatch(/\('lobby_strip',\s+1000\)/);
    expect(PRICE).toMatch(/\('session_summary',\s+800\)/);
    expect(PRICE).toMatch(/\('hub_promotions',\s+600\)/);
    expect(PRICE).toMatch(/\('empty_state',\s+500\)/);
    expect(PRICE).toMatch(/sponsor_cents_per_day % 100 <> 0/);
    expect(PRICE).toMatch(/sponsor_cents_per_day <> 2 \* diamonds_per_day/);
  });

  it('the quote is frozen on the flight at submit, and a zero price is not for sale', () => {
    expect(PRICE).toMatch(/add column if not exists quoted_cents integer/);
    expect(PRICE).toMatch(/v_quote := v_rate\.sponsor_cents_per_day \* p_days;/);
    expect(PRICE).toMatch(/if v_rate\.sponsor_cents_per_day <= 0 then[\s\S]*?surface_not_for_sale/);
    // Both sponsor paths write it; both lists return it.
    expect(PRICE.match(/quoted_cents\)\n\s+values/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(PRICE).toMatch(/drop function if exists public\.fn_sponsor_campaign_list\(\);/);
    expect(PRICE).toMatch(/drop function if exists public\.fn_ad_campaign_list\(uuid\);/);
    expect(SERVICE).toMatch(
      /quotedCents: r\.quoted_cents == null \? null : Number\(r\.quoted_cents\)/
    );
    expect(SERVICE).toMatch(/sponsor_cents_per_day'/);
  });

  it('a dollar figure on a forward-facing page has no decimals', () => {
    expect(SERVICE).toMatch(/return `\$\$\{Math\.floor\(cents \/ 100\)\.toLocaleString\(\)\}`;/);
    // Staff see what to invoice, in the same figure.
    expect(QUEUE).toMatch(/\$\{formatDollars\(c\.quotedCents \?\? 0\)\} To Invoice/);
  });
});

describe("the ad popup carries the sponsor's door (2026-09-13)", () => {
  it('Advertise With Us is a router link that closes the popup, and the route is no longer an orphan', () => {
    const popup = read('src/components/ads/AdInterstitial.tsx');
    expect(popup).toMatch(
      /<Link className="ad-interstitial__advertise" to="\/advertise" onClick=\{onClose\}>/
    );
    expect(popup).toMatch(/Advertise With Us/);
    expect(read('src/components/ads/AdInterstitial.css')).toMatch(
      /\.ad-interstitial__advertise \{/
    );
    expect(read('tests/unit/everyRouteIsReachableLaw.test.ts')).not.toMatch(/^\s+advertise:/m);
  });
});

describe("a sponsor's flight is billed, and a phone sponsor can log in (2026-09-14)", () => {
  const BILLED = read('supabase/migrations/20260914004548_a_sponsors_flight_is_billed.sql');

  it('the marks are an offline fact recorded by staff, on approved sponsor flights only', () => {
    expect(BILLED).toMatch(/add column if not exists invoiced_at timestamptz/);
    expect(BILLED).toMatch(/add column if not exists paid_at timestamptz/);
    expect(BILLED).toMatch(/if p_mark not in \('invoiced', 'paid', 'none'\) then/);
    expect(BILLED).toMatch(
      /if v_c\.club_id is not null or v_c\.quoted_cents is null then[\s\S]*?not_a_sponsor_flight/
    );
    expect(BILLED).toMatch(/if v_c\.status <> 'approved' then[\s\S]*?not_approved/);
    // Paid never without invoiced; the migration asserts it.
    expect(BILLED).toMatch(/a flight is paid without being invoiced/);
    // No chips and no diamonds: the function touches ad_campaign only.
    const fn = BILLED.slice(
      BILLED.indexOf('function public.fn_sponsor_campaign_bill'),
      BILLED.indexOf('revoke all on function public.fn_sponsor_campaign_bill')
    );
    expect(fn).not.toMatch(/diamond|chip_balance|fn_credit|fn_add_chips/);
    // Both lists return the marks.
    expect(
      BILLED.match(/quoted_cents integer, invoiced_at timestamptz, paid_at timestamptz/g)?.length
    ).toBe(2);
  });

  it('the hand-off finds the account by e-mail and refuses a second sponsor per account', () => {
    expect(BILLED).toMatch(
      /select u\.id into v_owner from auth\.users u where lower\(u\.email\) = v_email/
    );
    expect(BILLED).toMatch(/no_account_with_that_email/);
    expect(BILLED).toMatch(/account_already_has_a_sponsor/);
    expect(BILLED).toMatch(/already_handed_off/);
    expect(BILLED).toMatch(/self_serve\s+= true/);
  });

  it('the sponsor reads the same words staff wrote, and staff act from the reviewed table and the roster', () => {
    expect(SERVICE).toMatch(/export function billingLabel\(/);
    expect(SERVICE).toMatch(/if \(c\.paidAt\) return 'Paid';/);
    expect(SERVICE).toMatch(/if \(c\.invoicedAt\) return 'Invoice Sent';/);
    expect(SERVICE).toMatch(/if \(c\.status === 'approved'\) return 'To Be Invoiced';/);
    expect(PAGE).toMatch(/\{formatDollars\(c\.quotedCents\)\} \{billingLabel\(c\)\}/);
    expect(QUEUE).toMatch(/void bill\(c, c\.invoicedAt == null \? 'invoiced' : 'paid'\)/);
    expect(QUEUE).toMatch(/void bill\(c, 'none'\)/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_campaign_bill'/);
    expect(QUEUE).toMatch(/Hand Off/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_advertiser_handoff'/);
    expect(SERVICE).toMatch(/rpc\('fn_sponsor_advertiser_list'/);
    // The hand-off's e-mail falls back to the contact e-mail staff typed on the phone.
    expect(QUEUE).toMatch(/handoffEmail\[a\.id\] \?\? a\.contactEmail \?\? ''/);
  });
});

describe('an advert knows where it is (2026-09-14)', () => {
  const GEO = read('supabase/migrations/20260914011104_an_advert_knows_where_it_is.sql');
  const ADS = read('src/services/AdService.ts');

  it('a flight carries a country list, null means everywhere, and a bad code refuses the whole list', () => {
    expect(GEO).toMatch(/add column if not exists countries text\[\]/);
    expect(GEO).toMatch(
      /create or replace function public\.fn_ad_countries_clean\(p_countries text\[\]\)/
    );
    expect(GEO).toMatch(/btrim\(x\) !~ '\^\[A-Za-z\]\{2\}\$'\) then null/);
    expect(GEO).toMatch(/add constraint ad_campaign_countries_are_alpha2/);
    // Both submits refuse, never drop, a bad entry.
    expect(GEO.match(/'reason', 'bad_countries'/g)?.length).toBe(2);
    // Every existing flight runs everywhere; the migration asserts it.
    expect(GEO).toMatch(/an existing flight is gated; every existing flight runs everywhere/);
    // The client applies the same rule before the round trip.
    expect(SERVICE).toMatch(
      /export function parseCountries\(text: string\): string\[\] \| null \| undefined/
    );
    expect(SERVICE).toMatch(
      /if \(parts\.some\(\(x\) => !\/\^\[A-Za-z\]\{2\}\$\/\.test\(x\)\)\) return undefined;/
    );
  });

  it('the resolver takes a country and never serves a gated flight to an unknown location', () => {
    expect(GEO).toMatch(/drop function if exists public\.fn_resolve_ads\(text, uuid, integer\);/);
    expect(GEO).toMatch(/p_country text default null/);
    expect(GEO).toMatch(
      /and \(cam\.id is null or cam\.countries is null\s+or \(v_country is not null and v_country = any\(cam\.countries\)\)\)/
    );
    // One overload each, or PostgREST cannot pick.
    expect(GEO).toMatch(/expected one overload each of five functions/);
    // Anon can still resolve house ads.
    expect(GEO).toMatch(
      /grant execute on function public\.fn_resolve_ads\(text, uuid, integer, text\) to anon, authenticated, service_role;/
    );
  });

  it('the client asks the edge once, passes it as a hint, and treats a failure as unknown', () => {
    expect(ADS).toMatch(/fetch\('\/api\/geo', \{ credentials: 'omit', cache: 'no-store' \}\)/);
    expect(ADS).toMatch(/p_country: await playerCountry\(\),/);
    expect(ADS).toMatch(/return \/\^\[A-Z\]\{2\}\$\/\.test\(c\) \? c : null;/);
    expect(ADS).toMatch(/\} catch \{\s+return null;/);
  });

  it('a sponsor and staff both write the list, and both read it back', () => {
    expect(PAGE).toMatch(/countries: parseCountries\(countriesText\) \?\? null,/);
    expect(PAGE).toMatch(
      /const countriesOk = sponsorMode \? parseCountries\(countriesText\) !== undefined : true;/
    );
    expect(PAGE).toMatch(/Countries \(Optional\)/);
    expect(PAGE).toMatch(/A Player Whose Location Is Unknown Never Sees A Country-Limited Advert/);
    expect(QUEUE).toMatch(/countries: parseCountries\(sponsor\.countries\) \?\? null,/);
    expect(QUEUE).toMatch(/parseCountries\(sponsor\.countries\) !== undefined &&/);
    expect(SERVICE.match(/p_countries: input\.countries \?\? null,/g)?.length).toBe(2);
    expect(SERVICE).toMatch(
      /countries: Array\.isArray\(r\.countries\) \? r\.countries\.map\(\(x\) => String\(x\)\) : null,/
    );
  });
});
