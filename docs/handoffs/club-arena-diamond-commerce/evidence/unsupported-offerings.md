# Unsupported Offerings: Why Their Rights Are Not Established

Seven catalog SKUs are installed as products but cannot be sold:

- `report_export_7d`
- `report_pack_30d`
- `asset_club_cover`
- `asset_table_background`
- `asset_table_felt`
- `asset_theme_bundle`
- `asset_club_card_back`

Each has `supported = false` (M1:456-462) and a `validated` price that was never published (M1:474-480). The quote refuses each of them with `sku_not_available` (M2:275-277). Even if one were marked supported, the quote would still refuse it with `term_not_supported_yet`, because only `term_kind='period'` is quotable (M2:306-308). Proof:

- RM `D80 unsupported offerings carry no published price`
- RM `D80 an unsupported offering cannot be quoted`

This follows R2 7.3 (line 1289): "keep only that unsupported offering unavailable until its terms are established".

For every one of these SKUs, the D-tests that depend on it are N/A (scope) in `traceability-register.md` and cite this file: D13, D14, D15, D16, D48, D56, D57, D58 (report data), D59, D60, D61, and the local-date half of D51.

The reasons below are read from the repository source at `HEAD` `391f3814a`. Live RLS policies and live function bodies were **not** re-read for this document. Where a reason rests on a policy, the migration that last defines it is cited.

---

## `report_export_7d`: Detailed Club Export, 200 diamonds (candidate)

**Why the right is not established**

1. **Club data, rake and cashier exports are free today, so a paid interval grants nothing extra.**
   - Club Data exports every game or player row for any date range the owner picks. The Page is `src/pages/club/ClubDataPage.tsx:1873-1925`, which calls `ca_club_game_export_start` or `ca_club_player_export_start`. Those functions take `p_start date` and `p_end date` with no interval limit (`supabase/migrations/20260831144500_club_data_complete_export_jobs.sql:37-43`). That migration never mentions diamonds and never debits anyone.
   - The rake snapshot downloads a CSV (`src/components/club/RakeSnapshotPanel.tsx:810-811`). The panel is mounted on both the club and the union data pages (`src/pages/club/ClubDataPage.tsx:64`, `src/pages/UnionDataPage.tsx:28`).
   - The cashier statement export runs through `fn_cashier_statement_export_start` (`src/hooks/useCashierStatement.ts:877`).
   - R2 3.3 (line 649) keeps "core balances, transaction evidence, standard statements" included and permits selling only "export packaging/advanced functionality". No such differentiated export exists.
2. **The spec's report contract is not met** (R2 6.1, lines 1213-1231; D57 to D61).
   - **Interval.** The contract needs an exact `[data_start, data_end)` interval in a stored IANA zone, which can span a daylight-saving change (167, 168 or 169 hours). The entitlement table has `data_start`, `data_end` and `report_tz` columns (M1:290-292), but no function writes them. The quote cannot price a `report_interval` term at all (M2:306-308).
   - **Watermark and schema version.** No watermark column exists on any `ca_commerce_*` table.
   - **Durable snapshot job and retrieval.** The contract needs a bounded, paginated snapshot job with row counts and a complete or failed flag, a generation fence, authorized retrieval, and revocation by proxy or bounded signed-URL expiry. `ca_commerce_fulfillments` (M1:369-384) has `generation` and lease columns, but **no writer**: no function in M1 to M4 inserts into it.
   - **Linked refund on failure (D15).** It does not exist.
3. **Competitor evidence** (`../competitor-evidence-2026-09-24.md` section 7). ClubGG sells a 7-day export at an unpublished price, which is ND.

**What would establish it**

1. A product decision naming what the paid export adds beyond the free Club Data, rake and cashier exports: fields, granularity, format or retention. Otherwise, retire the SKU and keep exports free.
2. A quote path for `term_kind='report_interval'`. It takes local dates and a zone, stores `[data_start, data_end)` on the entitlement, and makes coverage interval-aware. A later 7-day, 30-day or union coverage must not charge twice for a covered interval (D57).
3. A fulfillment writer on `ca_commerce_fulfillments`, with each of these:
   - a generation or fencing token (D61)
   - the source watermark and schema version
   - row counts and complete, empty or failed labels (D60)
   - spreadsheet-formula sanitization (D60)
   - authorized retrieval rechecked at generation and at download (D14, D59)
   - a linked, exactly-once refund on permanent failure (D15)
4. Qualification of D13 to D15, the local-date half of D51, and D57 to D61. Then `fn_ca_commerce_product_support('report_export_7d', true)` and publication of the validated price.

## `report_pack_30d`: Club Reporting Pack, 700 diamonds (candidate)

**Why the right is not established**

- Every reason given for `report_export_7d` applies.
- The pack must also cover "overlapping weeks and the final partial week" and "regenerated exports" without a second charge (R2 3.3, line 647). Nothing implements interval coverage.
- Competitor evidence: no competitor sells an equivalent 30-day product. Poker Now includes summary reports in its Platinum bundle (`../competitor-evidence-2026-09-24.md`, section 7).

**What would establish it**

- Everything listed for `report_export_7d`.
- A defined relation between the 7-day and 30-day rights, and the union back office's included reports (R2 3.2, line 605), so that re-downloads and regeneration of a covered interval are not new purchases (D14, D57).

## `asset_club_cover`: Custom Premium Club Cover, 100 diamonds (candidate)

**Why the right is not established**

1. **The club cover column is freely writable by owners today, so a purchased right grants nothing until that write is closed.**
   - `uploadClubBanner` stores the image and writes `clubs.banner_url` directly through PostgREST (`src/services/ClubsService.ts:1184-1231`; the update is at lines 1221-1225).
   - The RLS policy `clubs_update` admits any update by the owner (`USING (owner_id = auth.uid())`, `supabase/migrations/20260126100_rls_verification.sql:143-144`).
   - No charge is involved.
2. R2 3.4 (line 691) keeps "basic logo, description, contact information and standard branding" included. So even after the write is closed, the paid SKU must be a defined premium cover distinct from the free banner.
3. There is no asset identity or content version, no consumer that reads a club-owned cover right, and no fallback on refund or trial expiry (R2 6.2). The asset identity index exists (M1:318-319), but no path writes an `asset_id`.
4. Competitor evidence: ClubGG custom club image upload is free (P1).

**What would establish it**

1. Move `banner_url` writes behind a server door. The door permits the free standard banner and requires an effective `asset_club_cover` entitlement for the premium cover.
2. Define the premium cover's asset ID and content version.
3. Make the quote support `term_kind='permanent'`.
4. Record `asset_id` on the entitlement, relying on the uniqueness at M1:318.
5. Define the fallback on refund.
6. Qualify D16, D48 and D56.

## `asset_table_background`, `asset_table_felt`, `asset_theme_bundle`: 250 / 350 / 600 diamonds (candidate)

**Why the right is not established**

1. **Table art is per player, not per club.**
   - The selection is stored per user: `user_theme_settings`, keyed `UNIQUE(user_id, game_type)` (`src/hooks/useUserThemeSettings.ts:6`, `:15`, read at `:248`), and `user_table_studio_preferences`, keyed by `user_id` (`supabase/migrations/20260829230000_table_studio_storefront_and_cloud_preferences.sql:114-124`).
   - The Table Studio header calls favorites and loadouts "player preferences" (same file, lines 5-7).
   - A search of the repository migrations found no club-level theme, felt or background column. There is therefore no consumer that would render a club-owned table asset for every seated player, as R2 3.4 (line 691) requires: "Operator-owned club artwork applies to its authorized tables".
2. **The same assets are sold personally at identical prices.**
   - `feature_pricing` sells `studio:background_id:<asset>` at 250, `studio:table_id:<asset>` at 350 and `studio:theme_id:<asset>` at 600 (`supabase/migrations/20260829230000_table_studio_storefront_and_cloud_preferences.sql:15-33`).
   - Each is bought only for the caller's own account (`supabase/migrations/20260830203000_entitlement_aware_customization_purchases.sql:40-43`).
   - The club SKUs carry the same 250, 350 and 600 (M1:477-479). Selling them as they are would create duplicate storefront SKUs for the same assets, which R2 3.4 forbids (line 693: "Do not create duplicate storefront SKUs for the same asset").
3. **The bundle is not defined.** `asset_theme_bundle` requires "explicit component IDs" and credit only for paid components (R2 3.4, lines 683 and 691; D56). No component list and no credit rule exist.

**What would establish them**

1. A club-scope table art model. A club-owned asset applies to the club's tables for every seated player, with a defined precedence against each player's own selection.
2. Distinct club licences on named asset IDs, rather than a second SKU for the same personal permission.
3. A renderer that reads the club asset.
4. For the theme bundle: explicit component IDs, and a deterministic component credit limited to actually paid, same-beneficiary components (D56).
5. A safe fallback on refund at a presentation boundary (D48).
6. Quote support for `term_kind='permanent'`.
7. Qualification of D16, D48 and D56.

## `asset_club_card_back`: Club-Branded Card Back, 250 diamonds (candidate)

**Why the right is not established**

1. **The club-branded card back is one generic image.**
   - The id `club-branded` is one of the fixed `CARD_BACK_IDS` (`src/components/table/CardImage.tsx:362-375`).
   - It renders a fixed red gradient, the same for every club (`src/components/table/CardImage.css:231-234`; `src/pages/TablePage.css:1186-1189`). No club logo or per-club asset exists.
2. **The same design is already sold personally at the identical price.**
   - `card_back_club-branded` costs 250, labelled "Club Crest card back" (`supabase/migrations/20260829190000_cosmetic_checkout_and_entitlement_delivery.sql:36`; first priced in `supabase/migrations/20260825_card_back_feature_pricing.sql:12`).
   - The client lists it as `{ id: 'club-branded', name: 'Club Crest', tier: 'exclusive', price: 250 }` (`src/components/table/CardImage.tsx:501`).
   - Selling `asset_club_card_back` as it is would sell a generic back under a "club-branded" name and duplicate an existing personal SKU.

**What would establish it**

1. A per-club card back asset: the club's crest or uploaded art, with an asset ID and content version.
2. A renderer that applies it at the club's tables.
3. A defined relationship to the existing personal `card_back_club-branded` right, so that one design is not sold twice.
4. Refund fallback, and D16 and D48.
