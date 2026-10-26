/**
 * LAW: a portrait phone lays the table out at the desktop's width.
 *
 * Dan, 2026-10-25, with a 603px-wide desktop window beside his phone: "SEATING
 * LOCATIONS NEED TO BE THE SAME AS WELL. AND NOTICE ON DESKTOP THE SIZE OF THE
 * AVATARS, AND HOW THEY REACH THE TOP OF THE PAGE AND 'CUT OFF' THATS PERFECT,
 * MAXIMIZE ALL THE SPACE WITHOUT 'CROWDING THE SCREEN'" and "THIS IS HOW IT
 * SHOULD LOOK ON MOBILE".
 *
 * The phone had its own table layout below 481px and it drifted from the
 * desktop's in seats, avatar size, felt and bets. Now the table in front lays
 * out at PHONE_TABLE_LAYOUT_WIDTH_PX and the browser scales it to the phone,
 * so the phone shows the desktop's own layout. Pinned here: the viewport the
 * table asks for, that it is asked for only by the ACTIVE table (a "+" tab
 * showing a World Hub page keeps the phone's own width), and that pinch-zoom
 * stays locked at that scale.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PHONE_TABLE_LAYOUT_WIDTH_PX,
  PHONE_TABLE_MAX_DEVICE_WIDTH_PX,
  tableViewportContent,
} from '../src/hooks/useTableEnvironment';

describe('a phone lays the table out like desktop', () => {
  it('lays out at the desktop layout width, scaled to the phone, with zoom locked', () => {
    expect(PHONE_TABLE_LAYOUT_WIDTH_PX).toBeGreaterThan(480);
    expect(PHONE_TABLE_LAYOUT_WIDTH_PX).toBeLessThanOrEqual(768);
    expect(PHONE_TABLE_MAX_DEVICE_WIDTH_PX).toBe(480);
    const content = tableViewportContent(393, true);
    expect(content).toContain(`width=${PHONE_TABLE_LAYOUT_WIDTH_PX}`);
    const scale = Number(/initial-scale=([\d.]+)/.exec(content)![1]);
    expect(scale * PHONE_TABLE_LAYOUT_WIDTH_PX).toBeCloseTo(393, 0);
    expect(content).toContain(`maximum-scale=${scale}`);
    expect(content).toContain(`minimum-scale=${scale}`);
    expect(content).toContain('user-scalable=no');
    expect(content).toContain('viewport-fit=cover');
  });

  it('keeps the device width when the table is not in front or the device is not a portrait phone', () => {
    for (const content of [tableViewportContent(393, false), tableViewportContent(null, true)]) {
      expect(content).toContain('width=device-width');
      expect(content).toContain('maximum-scale=1');
    }
  });

  it('only the active table asks for the desktop layout', () => {
    const hook = readFileSync(join(__dirname, '..', 'src/hooks/useTableEnvironment.ts'), 'utf8');
    expect(hook).toMatch(/if \(!isActive\) return;\s*desktopLayoutHolders \+= 1;/);
    expect(hook).toMatch(/\}, \[isActive\]\);/);
  });
});
