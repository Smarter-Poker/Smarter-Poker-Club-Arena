/**
 * FIFTY WAYS TO WRITE A HANDLE (Dan 2026-09-04)
 *
 * "Every horse poker alias is all too similar ... this needs to be random and
 * feel human ... create 50 different ways to display the horse names."
 *
 * These pin the two things that make that true and stay true: the style count
 * is fifty and every one of them is reachable, and the fleet's silhouette is
 * not one shape - single words, lowercase, ALLCAPS, digits, underscores, dots,
 * spaces, city codes, birth years, all present in a 1,000-horse sample.
 */
import { describe, it, expect } from 'vitest';
import {
  ALIAS_STYLES,
  ALIAS_SHAPE,
  MAX_ALIAS_LEN,
  MIN_ALIAS_LEN,
  styledAlias,
  styleIndexFor,
  usernameFromAlias,
} from './horseAliasStyles';

const ids = Array.from({ length: 1000 }, (_, i) => `horse-${i}-${(i * 7919) % 104729}`);
const sample = ids.map((id) => styledAlias(id));

describe('fifty styles', () => {
  it('there are exactly fifty', () => {
    expect(ALIAS_STYLES).toHaveLength(50);
  });

  it('every style is reachable in a thousand-horse fleet', () => {
    const seen = new Set(ids.map((id) => styleIndexFor(id)));
    for (let i = 0; i < ALIAS_STYLES.length; i++) {
      expect(seen.has(i), `style ${i + 1} never appears`).toBe(true);
    }
  });

  it('is deterministic per horse, and the attempt salt moves it', () => {
    for (const id of ids.slice(0, 50)) {
      expect(styledAlias(id)).toBe(styledAlias(id));
      expect(styledAlias(id, 1)).toBe(styledAlias(id, 1));
    }
    const moved = ids.slice(0, 50).filter((id) => styledAlias(id) !== styledAlias(id, 1)).length;
    expect(moved).toBeGreaterThan(40);
  });
});

describe('the fleet does not share one silhouette', () => {
  const camelPair = /^[A-Z][a-z]+[A-Z][a-z]+$/;

  it('the old CapitalCapital shape is a minority, not 87%', () => {
    // Eight of the fifty styles still produce it (it IS how some people
    // write a handle); measured 18% of a thousand-horse sample.
    const camel = sample.filter((a) => camelPair.test(a)).length;
    expect(camel / sample.length).toBeLessThan(0.25);
  });

  it('single words, lowercase, ALLCAPS, digits, underscores, dots and spaces all appear', () => {
    const count = (re: RegExp) => sample.filter((a) => re.test(a)).length;
    expect(count(/^[A-Za-z]+$/), 'letters-only').toBeGreaterThan(100);
    expect(count(/^[a-z]+$/), 'all lowercase').toBeGreaterThan(30);
    expect(count(/^[A-Z]+$/), 'ALLCAPS').toBeGreaterThan(10);
    expect(count(/\d/), 'with digits').toBeGreaterThan(150);
    expect(count(/_/), 'with an underscore').toBeGreaterThan(60);
    expect(count(/\./), 'with a dot').toBeGreaterThan(10);
    expect(count(/ /), 'with a space').toBeGreaterThan(10);
    expect(count(/^[a-z]/), 'starting lowercase').toBeGreaterThan(200);
    expect(count(/^[A-Z]/), 'starting uppercase').toBeGreaterThan(200);
  });

  it('is mostly unique across a thousand horses before any collision handling', () => {
    expect(new Set(sample).size).toBeGreaterThan(900);
  });
});

describe('every alias fits the plate and the shape', () => {
  it('never longer than the 11-character seat cut, never shorter than 3', () => {
    for (const a of sample) {
      expect(a.length, a).toBeLessThanOrEqual(MAX_ALIAS_LEN);
      expect(a.length, a).toBeGreaterThanOrEqual(MIN_ALIAS_LEN);
    }
    expect(MAX_ALIAS_LEN).toBe(11);
  });

  it('carries only letters, digits, underscore, dot, or a single space, never at the ends', () => {
    for (const a of sample) {
      expect(a, a).toMatch(ALIAS_SHAPE);
      expect(a).not.toMatch(/  /);
    }
  });
});

describe('usernameFromAlias', () => {
  it('always satisfies the profiles trigger', () => {
    const rule = /^[a-z0-9][a-z0-9_.]{2,19}$/;
    for (const id of ids) {
      expect(usernameFromAlias(styledAlias(id), id)).toMatch(rule);
    }
    expect(usernameFromAlias('Mr Flush', 'x')).toMatch(rule);
    expect(usernameFromAlias('xXSharkXx', 'x')).toMatch(rule);
    expect(usernameFromAlias('.._', 'x')).toMatch(rule);
  });
});
