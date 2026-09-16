/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAGE WATERFALLS — independent queries must not queue behind each other
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured against production 2026-08-23: these queries execute in ~9ms
 * server-side. What costs the user is the NUMBER of sequential round trips —
 * 150-250ms each wired, 250-400ms on mobile. Every await of a query that did
 * not need the one before it is a few hundred milliseconds of nothing
 * happening.
 *
 * Fixed on three pages, all of the same shape: a query needing only an id
 * already in hand, sitting behind a query it never reads.
 *
 *   HomePage      active-player counts behind the club rows they don't need
 *   ProfilePage   achievements + transactions behind the profile row
 *   CashierPage   display names and agent records in series, and the names
 *                 fetched one 200-id chunk at a time
 *
 * Pinned by source ordering rather than behaviour: these are large page
 * components with realtime subscriptions and heavy mocking requirements, and
 * what actually regresses is someone moving a query back inline during a
 * refactor. Ordering in the file is precisely the property that must hold.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

function indexOf(src: string, needle: string, label: string): number {
  const i = src.indexOf(needle);
  expect(i, `${label} — not found: ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('HomePage issues independent queries together', () => {
  const src = read('src/pages/HomePage.tsx');

  it('asks for active-player counts with the ids it already has', () => {
    const counts = indexOf(src, 'const activeCountsPromise = supabase', 'HomePage');
    const clubRows = indexOf(src, 'const { data: clubRows } = await supabase', 'HomePage');
    expect(counts, 'the counts RPC waits on the club rows again').toBeLessThan(clubRows);
    expect(
      /p_club_ids: clubRows\.map/.test(src),
      'the counts RPC is derived from clubRows again, which is what forced it into series'
    ).toBe(false);
  });
});

describe('ProfilePage issues independent queries together', () => {
  const src = read('src/pages/ProfilePage.tsx');

  it('starts achievements + transactions before awaiting the profile row', () => {
    const secondary = indexOf(
      src,
      'const secondaryDataPromise = Promise.allSettled(',
      'ProfilePage'
    );
    const profile = indexOf(
      src,
      'const { data: profile, error: profileError } = await retryFetch(',
      'ProfilePage'
    );
    expect(
      secondary,
      'the achievements/transactions batch is behind the profile fetch again'
    ).toBeLessThan(profile);
    expect(src).toContain('await secondaryDataPromise');
  });
});

describe('CashierPage issues independent queries together', () => {
  const src = read('src/pages/CashierPage.tsx');

  it('fetches display names and agent records in one wave', () => {
    expect(src).toContain('const [nameResults, agentResult] = await Promise.all([');
  });

  it('fetches every name chunk at once, not one chunk per round trip', () => {
    // A 588-member club needs three chunks; in series that was three round
    // trips before the agents query had even started.
    expect(src).toContain('nameChunks.map((chunk) =>');
    expect(
      /for \(let i = 0; i < needNames\.length; i \+= chunkSize\)[\s\S]{0,400}?await retryFetch/.test(
        src
      ),
      'the display-name chunks are being awaited one at a time again'
    ).toBe(false);
  });
});
