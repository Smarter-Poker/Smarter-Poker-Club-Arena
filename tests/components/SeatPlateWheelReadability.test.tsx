import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { WheelCabinet, WheelEntry } from '../../src/components/wheel/WheelCabinet';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css: string, selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].trim() === selector)
    .map((match) => match[2]);
afterEach(cleanup);

describe('player plates stay readable across the complete responsive cascade', () => {
  const css = read('src/components/table/SeatSlot.css');
  it('names and chip counts never return to the 8-10px phone sizes', () => {
    for (const [selector, floor] of [
      ['.seat__name', 0.75],
      ['.seat__stack', 0.875],
    ] as const) {
      const matches = rules(css, selector);
      expect(matches.length).toBeGreaterThan(0);
      for (const body of matches) {
        const size = body.match(/font-size:\s*(?:clamp\()?([\d.]+)rem/);
        expect(size, selector).not.toBeNull();
        expect(Number(size![1]), selector).toBeGreaterThanOrEqual(floor);
      }
    }
    const page = read('src/pages/TablePage.css');
    expect(rules(page, '.seat__name')).toEqual([]);
    expect(rules(page, '.seat__stack')).toEqual([]);
  });
  it('each plate fills its seat so wider names do not silently shrink the box', () => {
    expect(rules(css, '.seat__info')[0]).toMatch(/width:\s*100%/);
    for (const body of rules(css, '.seat__info')) {
      const height = body.match(/min-height:\s*(?:clamp\()?([\d.]+)px/);
      expect(height).not.toBeNull();
      // Owner-requested proportional mobile boxes retain room for two readable lines.
      expect(Number(height![1])).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('Diamond Spins data and actions own separate layout space', () => {
  const css = read('src/components/wheel/WheelCabinet.module.css');
  it('never reserves a fixed minimum action width at any breakpoint', () => {
    for (const body of rules(css, '.dashboard')) {
      const columns = body.match(/grid-template-columns:\s*([^;]+)/);
      if (columns) {
        expect(columns[1]).toMatch(/^minmax\(0, 1fr\)( minmax\(0, 310px\))?$/);
      }
    }
    for (const body of rules(css, '.actions button')) {
      const size = body.match(/font-size:\s*([\d.]+)px/);
      if (size) expect(Number(size[1])).toBeGreaterThanOrEqual(18);
    }
  });
  it('keeps complete action plates and slices small-control corners beyond their chamfers', () => {
    const action = rules(css, '.actions button')[0];
    expect(action).toMatch(/background-size:\s*contain/);
    expect(action).not.toMatch(/clip-path/);
    expect(css).not.toContain('wheel-matte-controls-v1');
    expect(css).not.toContain('shark-panel-v1/button-');
    for (const selector of ['.entry input', '.presets button']) {
      expect(rules(css, selector)[0]).toMatch(/260 fill \/ 7px/);
    }
    for (const name of ['frame', 'silver', 'blue']) {
      const png = readFileSync(`public/assets/diamond-spins/controls-clean-v2/${name}.png`);
      expect(png.readUInt32BE(16)).toBeGreaterThan(2000);
      expect(png.readUInt32BE(20)).toBeGreaterThan(700);
      expect(png[25]).toBe(6); // RGBA, preserving the generated exterior transparency.
    }
  });
  it('preserves live balances, explicit entry and separate Run/Spin controls', () => {
    let stake = 0;
    render(
      <WheelCabinet
        title="Diamond Spins"
        titleId="wheel-title"
        bays={[
          { label: 'Diamonds', value: '471K' },
          { label: 'Club Chips', value: '2.6K' },
        ]}
        setup={
          <WheelEntry
            value={100}
            disabled={false}
            onChange={(value) => {
              stake = value;
            }}
          />
        }
        secondary={{ label: 'Run Off', onClick: () => {} }}
        primary={{ label: 'Spin 100', disabled: true, onClick: () => {} }}
      />
    );
    const list = screen.getByText('471K').closest('dl')!;
    expect(list.textContent).toContain('471K');
    expect(list.parentElement).toBe(
      screen.getByRole('button', { name: 'Run Off' }).parentElement?.parentElement
    );
    expect(screen.getByRole('button', { name: 'Spin 100' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Diamonds To Spin'), { target: { value: '375' } });
    expect(stake).toBe(375);
  });
});
