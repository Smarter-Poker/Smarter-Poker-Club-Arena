import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Ticker Management Scroll Speed control', () => {
  const panel = read('src/components/club/TickerManagementPanel.tsx');
  const styles = read('src/components/club/TickerManagementPanel.module.css');

  it('keeps the saved speed contract on the native range', () => {
    const range = panel.match(/<input\s+type="range"[\s\S]*?\/>/)?.[0] ?? '';

    expect(range).toContain('aria-label="Scroll Speed"');
    expect(range).toContain('min="8"');
    expect(range).toContain('max="60"');
    expect(range).toContain('step="1"');
    expect(range).toContain('value={settings.speedSeconds}');
    expect(range).toContain('aria-valuetext={`${settings.speedSeconds} Seconds`}');
    expect(range).toContain("update('speedSeconds', Number(e.target.value))");
  });

  it('moves vertically inside a real 44px touch target', () => {
    const rangeRule = styles.match(/\.customizer input\[type='range'\] \{[^}]*\}/s)?.[0] ?? '';

    expect(rangeRule).toContain('width: 44px');
    expect(rangeRule).toContain('min-width: 44px');
    expect(rangeRule).toContain('min-height: 44px');
    expect(rangeRule).toContain('writing-mode: vertical-lr');
    expect(rangeRule).toContain('direction: rtl');
    expect(rangeRule).toContain('touch-action: none');
  });
});
