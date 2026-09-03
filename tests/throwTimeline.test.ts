/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THROW TIMELINE — every throwable must stay on screen 3.5-5 seconds
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan asked twice for this, which is the tell that "I measured it and it's
 * fine" was not good enough: the number needs to be ENFORCED, not trusted.
 *
 * This parses the real constants out of ThrowAnimation.tsx and the real
 * catalog out of ThrowableService.ts and reconstructs the timeline the
 * component actually schedules:
 *
 *   WINDUP + max(MIN_FLIGHT, physics-or-override) + life
 *   life = max(MIN_IMPACT_LIFE, max(TARGET_TOTAL, MIN_TOTAL) - windup - flight)
 *
 * Reading the source rather than importing it is deliberate: the component
 * pulls in CSS and the audio engine, so importing it here would drag a browser
 * environment into a pure-logic test. The constants are simple literals; if
 * someone renames one, this fails loudly rather than silently measuring
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const tsx = readFileSync(path.join(ROOT, 'src/components/table/ThrowAnimation.tsx'), 'utf8');
const svc = readFileSync(path.join(ROOT, 'src/services/ThrowableService.ts'), 'utf8');

function num(name: string): number {
  const m = tsx.match(new RegExp(`const ${name} = (\\d+);`));
  expect(m, `constant ${name} not found in ThrowAnimation.tsx`).toBeTruthy();
  return Number(m![1]);
}

const WINDUP = num('WINDUP_DURATION');
const TARGET_TOTAL = num('TARGET_TOTAL_MS');
const MIN_LIFE = num('MIN_IMPACT_LIFE_MS');
const MIN_FLIGHT = num('MIN_FLIGHT_MS');
const MIN_TOTAL = num('MIN_TOTAL_MS');

const physics: Record<string, number> = {};
for (const m of tsx.matchAll(/(\w+): \{ duration: (\d+), arc: -?\d+ \}/g)) {
  physics[m[1]] = Number(m[2]);
}

const overrides: Record<string, number> = {};
const ovBlock = tsx.match(/DURATION_OVERRIDES: Record<string, number> = \{([^}]+)\}/s);
if (ovBlock) {
  for (const m of ovBlock[1].matchAll(/(\w+): (\d+)/g)) overrides[m[1]] = Number(m[2]);
}

/** [id, physicsProfile] for every catalog item. */
const items = [...svc.matchAll(/T\(\s*'([a-z0-9_]+)',\s*'[^']+',\s*'\w+',\s*'(\w+)'/gs)].map(
  (m) => [m[1], m[2]] as const
);

function timeline(id: string, profile: string) {
  const base = physics[profile];
  const flight = Math.max(MIN_FLIGHT, overrides[id] ?? base);
  const life = Math.max(MIN_LIFE, Math.max(TARGET_TOTAL, MIN_TOTAL) - WINDUP - flight);
  return { flight, life, total: WINDUP + flight + life };
}

describe('throw timeline', () => {
  it('parsed real constants and a full catalog', () => {
    expect(items.length).toBeGreaterThanOrEqual(45);
    expect(Object.keys(physics).length).toBeGreaterThanOrEqual(7);
    for (const [, profile] of items) {
      expect(physics[profile], `unknown physics profile '${profile}'`).toBeTruthy();
    }
  });

  it('EVERY throwable lasts between 3.5 and 5 seconds', () => {
    for (const [id, profile] of items) {
      const { total } = timeline(id, profile);
      expect(total, `'${id}' total ${total}ms is outside 3500-5000ms`).toBeGreaterThanOrEqual(3500);
      expect(total, `'${id}' total ${total}ms is outside 3500-5000ms`).toBeLessThanOrEqual(5000);
    }
  });

  it('no throwable crosses the table in under 700ms', () => {
    // A throw you cannot follow with your eye reads as "it lasted a split
    // second" no matter how long it then sits at the target.
    for (const [id, profile] of items) {
      const { flight } = timeline(id, profile);
      expect(flight, `'${id}' flies for only ${flight}ms`).toBeGreaterThanOrEqual(700);
    }
  });

  it('every throwable holds at the target for at least 1.8s', () => {
    for (const [id, profile] of items) {
      const { life } = timeline(id, profile);
      expect(life, `'${id}' only holds ${life}ms`).toBeGreaterThanOrEqual(1800);
    }
  });
});
