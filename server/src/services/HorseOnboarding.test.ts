/**
 * V14 HORSE ONBOARDING — Dan 2026-08-23:
 * "ANYTIME A NEW HORSE IS CREATED IT GETS ASSIGNED A REAL NAME, POKER ALIAS,
 *  PLAYER NUMBER, REALISTIC PHOTO..., LIFETIME VIP CARD GRANTED, HAS ITS
 *  HORSE BRAIN FULLY WIRED, AND THE ABILITY TO POST ON SOCIAL MEDIA."
 *
 * Pure halves only — the DB round trip is exercised in production by the boot
 * sweep. What is pinned here is that the identity a horse is given is stable,
 * human-looking and distinct, and that the brain is fully wired rather than
 * left for the id-hash fallback to guess.
 */

import { describe, it, expect } from 'vitest';
import { identityFor, brainFor } from './HorseOnboarding.js';

const ids = Array.from({ length: 400 }, (_, i) => `id-${i}-${(i * 7919) % 104729}`);

describe('identity', () => {
  it('is stable for a horse - the same person every time it runs', () => {
    for (const id of ids.slice(0, 40)) {
      expect(identityFor(id)).toEqual(identityFor(id));
    }
  });

  it('gives a real-looking name AND a separate poker alias', () => {
    for (const id of ids.slice(0, 60)) {
      const i = identityFor(id);
      // A real name is two words; an alias is a nickname, not the same string.
      expect(i.realName.split(' ').length).toBe(2);
      expect(i.alias).not.toContain(' ');
      expect(i.alias.toLowerCase()).not.toBe(i.realName.toLowerCase());
      expect(i.username).toMatch(/^[a-z]+\d{3}$/);
    }
  });

  it('keeps an authored name if the horse already has one', () => {
    // Half the fleet were given real names by hand; onboarding must not
    // overwrite somebody's work with a generated one.
    expect(identityFor(ids[0], 'Marcus Chen').realName).toBe('Marcus Chen');
    expect(identityFor(ids[0], '  ').realName).not.toBe('  ');
  });

  it('a horse lives on the clock of the place it lives in', () => {
    // These were two independent lists on the first cut, which produced people
    // from Austin keeping Madrid hours. The timezone is load-bearing: the
    // social scheduler decides when a horse is awake from it, so a mismatch
    // means a posting rhythm that contradicts the horse's own profile.
    const expected: Record<string, string> = {
      'Austin, TX': 'America/Chicago',
      'Las Vegas, NV': 'America/Los_Angeles',
      'Brooklyn, NY': 'America/New_York',
      'Barcelona, ES': 'Europe/Madrid',
      'Manila, PH': 'Asia/Manila',
    };
    for (const id of ids) {
      const i = identityFor(id);
      const want = expected[i.location];
      if (want) expect(i.timezone, `${i.location} should not be on ${i.timezone}`).toBe(want);
      // and a US city is never on a European clock, whatever the city
      if (/, (NV|CA|TX|NY|FL|IL|AZ|CO|WA|NJ)$/.test(i.location)) {
        expect(i.timezone.startsWith('America/')).toBe(true);
      }
    }
  });

  it('spreads the fleet across names, aliases and clocks', () => {
    const names = new Set(ids.map((i) => identityFor(i).realName));
    const aliases = new Set(ids.map((i) => identityFor(i).alias));
    const zones = new Set(ids.map((i) => identityFor(i).timezone));
    // A fleet where everyone is called the same thing is worse than no names.
    expect(names.size).toBeGreaterThan(150);
    expect(aliases.size).toBeGreaterThan(150);
    // Horses sleep on their own clock; one timezone means one rhythm.
    expect(zones.size).toBeGreaterThan(5);
  });
});

describe('brain wiring', () => {
  it('always produces a style AND all four dials', () => {
    for (const id of ids.slice(0, 60)) {
      const b = brainFor(id, null);
      expect(typeof b.style).toBe('string');
      for (const dial of ['tightness', 'aggression', 'bluffFreq', 'sizingMultiplier']) {
        expect(typeof b[dial], `${dial} missing`).toBe('number');
      }
    }
  });

  it('dials land inside the range the self-tuner is allowed to move them in', () => {
    for (const id of ids.slice(0, 120)) {
      const b = brainFor(id, null);
      for (const dial of ['tightness', 'aggression', 'bluffFreq', 'sizingMultiplier']) {
        expect(b[dial] as number).toBeGreaterThanOrEqual(0.85);
        expect(b[dial] as number).toBeLessThanOrEqual(1.18);
      }
    }
  });

  it('preserves an authored style, including the bare-string legacy shape', () => {
    // Several seed paths wrote horse_profile as a bare string. Collapsing that
    // would erase a chosen personality permanently.
    expect(brainFor('x', 'maniac').style).toBe('maniac');
    expect(brainFor('x', { style: 'nit', aggression: 1.05 }).style).toBe('nit');
    expect(brainFor('x', { style: 'nit', aggression: 1.05 }).aggression).toBe(1.05);
  });

  it('never leaves the style to the id-hash fallback', () => {
    // An empty horse_profile makes resolveHorseStyle pick a style by hashing
    // the id — a personality nobody chose. Onboarding must always author one.
    for (const id of ids.slice(0, 40)) {
      expect(brainFor(id, {}).style).toBeTruthy();
    }
  });

  it('gives horses DIFFERENT dials, not one shared default', () => {
    const sig = new Set(ids.slice(0, 200).map((i) => JSON.stringify(brainFor(i, null))));
    expect(sig.size).toBeGreaterThan(150);
  });
});
