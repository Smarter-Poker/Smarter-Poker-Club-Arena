/**
 * A SETTING NOBODY CAN SET IS NOT A SETTING (BBJ build plan phase 3.4).
 *
 * Phase 3.4 shipped the whole sending half - the `bbj_notify_thresholds`
 * table, the five-minute sender, the crossing ledger that makes it say a thing
 * once - and NO way for a club to set a number. The phase-3 deep dive found
 * it: nothing in `src/` or `server/src/` referenced either new table.
 *
 * This page has the mirror-image mistake written into it already. The BBJ Rake
 * switch that used to sit in the same section wrote a column nothing read, and
 * was removed on 2026-09-05 with the note that "showing it did the one thing
 * worse than not offering the control, which is to say it had been used." A
 * control with no reader and a reader with no control are the same defect.
 *
 * Source pins, because the panel's real behaviour is RLS - `fn_is_club_admin_uid`
 * decides who may write, in the database, and a jsdom render cannot exercise
 * that. What is pinned here is that the control exists, is mounted, reaches
 * the right table, and is not quietly hidden from the clubs that need it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const PANEL = read('src/components/bbj/BBJThresholdPanel.tsx');
const SETTINGS = read('src/pages/ClubSettingsPage.tsx');
const MIGRATION = read(
  'supabase/migrations/20260906234056_the_jackpot_says_when_it_crosses_a_number_the_club_chose.sql'
);

describe('the club can actually set the number', () => {
  it('the panel is mounted on the settings page', () => {
    expect(SETTINGS).toMatch(/import BBJThresholdPanel from/);
    expect(SETTINGS).toMatch(/<BBJThresholdPanel\s+clubId=\{clubId\}/);
  });

  it('it reaches the table the sender reads, by name', () => {
    /* If these two ever disagree, the operator sets a number in one place and
       the sender reads another - which is precisely the failure the removed
       BBJ Rake switch was. */
    expect(PANEL).toMatch(/from\('bbj_notify_thresholds'\)/);
    expect(MIGRATION).toMatch(/FROM public\.bbj_notify_thresholds th/);
  });

  it('it can add, disable and remove - not just display', () => {
    expect(PANEL).toMatch(/\.insert\(\{/);
    expect(PANEL).toMatch(/\.update\(\{ enabled: !row\.enabled/);
    expect(PANEL).toMatch(/\.delete\(\)/);
  });
});

describe('who sees it, and where', () => {
  it('a club inside a union still gets the control', () => {
    /* The rake settings above it are `{!inUnion && ...}` because a union sets
       those centrally. Thresholds are NOT that: a union banks one jackpot for
       all of its clubs, but each club notifies its OWN members, so a union
       club has a real decision here. Pinning that the mount is not swallowed
       by the inUnion block. */
    const at = SETTINGS.indexOf('<BBJThresholdPanel');
    const inUnionAt = SETTINGS.indexOf('{!inUnion && (');
    expect(at).toBeGreaterThan(0);
    expect(inUnionAt).toBeGreaterThan(0);
    /* The !inUnion section closes before the panel: the panel's index is after
       the `</section>` that ends it, which is what `sliceEnclosingBlock` on the
       panel's own line confirms - it is a sibling, not a child. */
    const block = sliceEnclosingBlock(SETTINGS, '<BBJThresholdPanel', 0, 1);
    expect(block).not.toContain('!inUnion');
  });

  it('a non-admin sees the list and no buttons', () => {
    /* The database would refuse their write anyway (bbj_thresholds_admin_write
       is scoped to fn_is_club_admin_uid), so offering the button would only
       produce an error the member cannot act on. */
    expect(PANEL).toMatch(/canEdit: boolean/);
    expect(PANEL).toMatch(/\{canEdit && \(/);
    expect(SETTINGS).toMatch(/canEdit=\{isOwner \|\| isClubStaff\(userRole\)\}/);
  });
});

describe('it tells the operator what they are deciding', () => {
  it('shows the live jackpot beside the input', () => {
    /* Picking a threshold without seeing where the jackpot actually is makes
       the number a guess. It reads the same shared feed as every other surface
       (phase 3.2) rather than opening a subscription of its own. */
    expect(PANEL).toMatch(/watchBbjPool\(clubId,/);
    expect(PANEL).toMatch(/The Jackpot Is Currently/);
  });

  it('says plainly when a club has set none', () => {
    expect(PANEL).toMatch(/Your Members Are Not Told When The Jackpot Grows\./);
  });

  it('a duplicate amount is explained, not reported as a failure', () => {
    /* The unique index is (club_id, amount), so "you already have that number"
       is the ordinary refusal here and reporting it as an error would send a
       false alarm on a correct outcome. */
    expect(PANEL).toMatch(/duplicate\|unique/);
    expect(PANEL).toMatch(/That Amount Is Already On The List\./);
  });
});
