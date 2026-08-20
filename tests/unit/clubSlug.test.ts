/**
 * clubSlug — slug collision-proofing + ilike escaping for club creation.
 * clubs.slug has a UNIQUE index; these helpers guarantee create retries
 * cannot collide and duplicate-name checks match literally.
 */

import { describe, it, expect } from 'vitest';
import { normalizeClubSlug, buildClubSlug, escapeIlikePattern } from '@/utils/clubSlug';

describe('normalizeClubSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(normalizeClubSlug('Alpha Club')).toBe('alpha-club');
  });

  it('collapses symbol runs so variant names normalize identically', () => {
    expect(normalizeClubSlug('Alpha  Club!')).toBe('alpha-club');
    expect(normalizeClubSlug('ALPHA-CLUB')).toBe('alpha-club');
  });

  it('returns empty string for all-symbol names', () => {
    expect(normalizeClubSlug('!!! ***')).toBe('');
  });
});

describe('buildClubSlug', () => {
  it('uses the pretty slug on the first attempt', () => {
    expect(buildClubSlug('Alpha Club', 12345, 0)).toBe('alpha-club');
  });

  it('appends the club_id on retries (unique-violation recovery)', () => {
    expect(buildClubSlug('Alpha Club', 12345, 1)).toBe('alpha-club-12345');
    expect(buildClubSlug('Alpha Club', 54321, 2)).toBe('alpha-club-54321');
  });

  it('falls back to club-<id> when normalization is empty', () => {
    expect(buildClubSlug('!!!', 12345, 0)).toBe('club-12345');
  });
});

describe('escapeIlikePattern', () => {
  it('escapes percent, underscore, and backslash', () => {
    expect(escapeIlikePattern('100% Club')).toBe('100\\% Club');
    expect(escapeIlikePattern('under_score')).toBe('under\\_score');
    expect(escapeIlikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves normal names untouched', () => {
    expect(escapeIlikePattern('Alpha Club')).toBe('Alpha Club');
  });
});
