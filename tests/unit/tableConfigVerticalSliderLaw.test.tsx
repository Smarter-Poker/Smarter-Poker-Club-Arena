import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Slider } from '../../src/components/table-config/controls';

describe('Table Config vertical control law', () => {
  it('exposes a vertical native range and preserves value changes', () => {
    const onChange = vi.fn();
    render(<Slider label="Table Size" value={6} min={2} max={9} onChange={onChange} />);

    const range = screen.getByRole('slider', { name: 'Table Size' });
    expect(range).toHaveAttribute('aria-orientation', 'vertical');
    fireEvent.change(range, { target: { value: '8' } });
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it('draws the shared creator slider up and down, never side to side', () => {
    const css = fs.readFileSync(path.resolve('src/pages/TableConfigPage.css'), 'utf8');
    const start = css.indexOf('.slider-input {');
    const end = css.indexOf('\n}', start);
    const rule = css.slice(start, end);

    expect(rule).toContain('writing-mode: vertical-lr');
    expect(rule).toContain('direction: rtl');
    expect(rule).toContain('touch-action: none');
    expect(rule).not.toContain('width: 100%');
  });
});
