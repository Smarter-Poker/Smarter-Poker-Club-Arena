import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('table captions show every word (owner 2026-10-26)', () => {
  it('keeps the event, buy-in and hand number without ellipsis rules', () => {
    const css = read('src/pages/TablePage.css');
    for (const selector of ['.table-brand__line', '.table-brand__game']) {
      const body = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
      expect(body).toContain('white-space: normal');
      expect(body).toContain('overflow: visible');
      expect(body).toContain('overflow-wrap: anywhere');
      expect(body).not.toContain('text-overflow: ellipsis');
    }
    expect(css).toMatch(
      /\.table-page--tournament \.table-brand__line--level \{[^}]*flex-direction: column/
    );
    // Check every breakpoint, rather than just the first desktop declaration.
    for (const body of css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .matchAll(/[^{}]*\.table-brand[^{}]*\{([^}]*)\}/g)) {
      expect(body[1]).not.toContain('white-space: nowrap');
      expect(body[1]).not.toContain('text-overflow: ellipsis');
    }
  });

  it('prints complete player names and wraps winning-hand descriptions on phones', () => {
    const seat = read('src/components/table/SeatSlot.tsx');
    expect(seat).toContain('{player.name?.trim()}');
    expect(seat).not.toContain('limitSeatName');
    const css = read('src/components/table/SeatSlot.css');
    const name = css.slice(css.indexOf('.seat__name {')).split('}')[0];
    expect(name).toContain('white-space: normal');
    expect(name).toContain('overflow-wrap: anywhere');
    expect(css).not.toContain('text-overflow: ellipsis');
    expect(read('src/components/table/PotDisplay.css')).not.toContain('text-overflow: ellipsis');
  });
  it('keeps complete speech and add-on notices instead of a four-line excerpt', () => {
    const css = read('src/components/table/ChatBubble.css');
    expect(css).not.toContain('text-overflow: ellipsis');
    expect(css).not.toMatch(/(?:-webkit-)?line-clamp\s*:/);
    expect(css).toContain('overflow-wrap: anywhere');
  });
});
