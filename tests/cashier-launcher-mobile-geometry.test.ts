import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const css = readFileSync(resolve(root, 'src/pages/HomePage.module.css'), 'utf8');

describe('Cashier wallet directory phone geometry', () => {
  it('anchors the long-press directory to viewport safe areas at 480px and below', () => {
    const phoneRule = css.match(
      /@media \(max-width: 480px\)\s*\{\s*\.cashierSwitchMenu\s*\{([\s\S]*?)\n\s*\}\s*\}/
    )?.[1];
    expect(phoneRule).toBeTruthy();
    expect(phoneRule).toContain('position: fixed');
    expect(phoneRule).toMatch(/left:\s*max\(8px, env\(safe-area-inset-left\)\)/);
    expect(phoneRule).toMatch(/right:\s*max\(8px, env\(safe-area-inset-right\)\)/);
    expect(phoneRule).toContain('min-width: 0');
    expect(phoneRule).toContain('max-width: none');
    expect(phoneRule).toContain('transform: none');
  });
});
