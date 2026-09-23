/**
 * THE WEEKLY SCHEDULE EDITOR (owner requirements, 2026-09-20).
 *
 *  - start times are dropdowns of quarter-hour slots, never a native picker;
 *  - a saved off-grid time (19:05) stays selectable and is never rewritten;
 *  - `hideInterval` offers set times only, and hands an interval value back as
 *    'times' without crashing;
 *  - day buttons are named for assistive tech (aria-label + aria-pressed), not
 *    by a hover-only title;
 *  - Remove and Add Time are words, not glyphs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import WeeklyScheduleEditor, {
  validateWeeklySchedule,
  type WeeklyScheduleValue,
} from '../../src/components/tournament/WeeklyScheduleEditor';
import { MttPayoutDepthOptions } from '../../src/components/tournament/MttPayoutDepthOptions';

afterEach(cleanup);

const value: WeeklyScheduleValue = {
  daysOfWeek: [1, 3],
  startTimesUtc: ['18:00', '19:05', '21:30'],
  mode: 'times',
  intervalMinutes: 60,
};

function Host({
  initial,
  hideInterval,
  onEmit,
}: {
  initial: WeeklyScheduleValue;
  hideInterval?: boolean;
  onEmit: (v: WeeklyScheduleValue) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <WeeklyScheduleEditor
      value={v}
      hideInterval={hideInterval}
      onChange={(next) => {
        onEmit(next);
        setV(next);
      }}
    />
  );
}

describe('start times are dropdowns', () => {
  it('renders a select per start time and no native time input', () => {
    const { container } = render(<WeeklyScheduleEditor value={value} onChange={() => {}} />);
    expect(container.querySelector('input[type="time"]')).toBeNull();
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.map((s) => s.value)).toEqual(['18:00', '19:05', '21:30']);
    expect(selects[0].getAttribute('aria-label')).toBe('Start Time 1 (UTC)');
  });

  it('keeps the saved off-grid time selectable and selected', () => {
    render(<WeeklyScheduleEditor value={value} onChange={() => {}} />);
    const offGrid = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    expect(offGrid.value).toBe('19:05');
    expect(within(offGrid).getAllByRole('option')).toHaveLength(97);
    expect(within(offGrid).getByRole('option', { name: '19:05' })).toBeTruthy();
    // The on-grid rows do not grow an extra option.
    expect(within(screen.getAllByRole('combobox')[0]).getAllByRole('option')).toHaveLength(96);
  });

  it('emits the same HH:MM format, and editing one time leaves the off-grid one alone', () => {
    const onEmit = vi.fn();
    render(<Host initial={value} onEmit={onEmit} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '17:45' } });
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toEqual({
      ...value,
      startTimesUtc: ['17:45', '19:05', '21:30'],
    });
    expect(validateWeeklySchedule(onEmit.mock.calls[0][0])).toBeNull();
  });

  it('uses words for Remove and Add Time, and keeps the pinned accessible name', () => {
    const onEmit = vi.fn();
    render(<Host initial={value} onEmit={onEmit} />);
    const removes = screen.getAllByRole('button', { name: 'Remove This Start Time' });
    expect(removes).toHaveLength(3);
    expect(removes[0].textContent).toBe('Remove');
    const add = screen.getByRole('button', { name: 'Add Time' });
    expect(add.textContent).toBe('Add Time');
    fireEvent.click(removes[0]);
    expect(onEmit.mock.calls[0][0].startTimesUtc).toEqual(['19:05', '21:30']);
    fireEvent.click(screen.getByRole('button', { name: 'Add Time' }));
    expect(onEmit.mock.calls[1][0].startTimesUtc).toEqual(['19:05', '21:30', '20:00']);
  });
});

describe('day buttons', () => {
  it('are named and report their pressed state without a title attribute', () => {
    const onEmit = vi.fn();
    render(<Host initial={value} onEmit={onEmit} />);
    const monday = screen.getByRole('button', { name: 'Monday' });
    const tuesday = screen.getByRole('button', { name: 'Tuesday' });
    expect(monday.getAttribute('aria-pressed')).toBe('true');
    expect(tuesday.getAttribute('aria-pressed')).toBe('false');
    expect(monday.hasAttribute('title')).toBe(false);
    fireEvent.click(tuesday);
    expect(onEmit.mock.calls[0][0].daysOfWeek).toEqual([1, 3, 2]);
    expect(screen.getByRole('button', { name: 'Tuesday' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });
});

describe('hideInterval', () => {
  it('defaults to offering both modes', () => {
    render(<WeeklyScheduleEditor value={value} onChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('Repeat Every N Minutes')).toBeTruthy();
  });

  it('offers set times only', () => {
    render(<WeeklyScheduleEditor value={value} hideInterval onChange={() => {}} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByText('Repeat Every N Minutes')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('presents an interval value as its times and hands it back as times', () => {
    const onEmit = vi.fn();
    const interval: WeeklyScheduleValue = { ...value, mode: 'interval', intervalMinutes: 45 };
    render(<Host initial={interval} hideInterval onEmit={onEmit} />);
    // Shown as times, not as the interval field.
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    // Handed back once as 'times', everything else untouched, and it settles.
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toEqual({ ...interval, mode: 'times' });
    // Later edits keep emitting 'times'.
    fireEvent.change(screen.getAllByRole('combobox')[2], { target: { value: '22:00' } });
    expect(onEmit.mock.calls[1][0].mode).toBe('times');
    expect(onEmit.mock.calls[1][0].startTimesUtc).toEqual(['18:00', '19:05', '22:00']);
  });

  it('emits times even when the parent never stores the correction', () => {
    const onChange = vi.fn();
    const interval: WeeklyScheduleValue = { ...value, mode: 'interval' };
    render(<WeeklyScheduleEditor value={interval} hideInterval onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
    for (const call of onChange.mock.calls) expect(call[0].mode).toBe('times');
  });
});

describe('validation copy is Title Case in the source', () => {
  it('says what is wrong in Title Case, with no em dash', () => {
    const messages = [
      validateWeeklySchedule({ ...value, daysOfWeek: [] }),
      validateWeeklySchedule({ ...value, startTimesUtc: [''] }),
      validateWeeklySchedule({ ...value, startTimesUtc: ['7pm'] }),
      validateWeeklySchedule({ ...value, mode: 'interval', intervalMinutes: 2 }),
    ];
    expect(messages).toEqual([
      'Pick At Least One Day Of The Week.',
      'Add At Least One Start Time.',
      'Start Times Must Be HH:MM, 24-Hour.',
      'The Repeat Interval Must Be 5 To 1440 Minutes.',
    ]);
    for (const m of messages) expect(m).not.toContain('—');
  });
});

describe('the editor prints on the glass', () => {
  const css = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'tournament', 'WeeklyScheduleEditor.css'),
    'utf8'
  );
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('draws no card, no round chip, no dashed button, and has no hover or transition', () => {
    expect(rules).not.toMatch(/border-radius:\s*[^0\s]/);
    expect(rules).not.toContain('dashed');
    expect(rules).not.toContain(':hover');
    expect(rules).not.toContain('transition');
    expect(rules).not.toContain('gradient');
    const root = rules.match(/\.weekly-schedule-editor\s*\{[^}]*\}/)![0];
    expect(root).not.toContain('border');
    expect(root).not.toContain('background');
  });

  it('uses schema inks only', () => {
    const hexes = new Set((rules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()));
    const schema = new Set([
      '#e4e7ec',
      '#f4f7fb',
      '#45adff',
      '#ff5b6e',
      '#9aa5b3',
      '#000',
      '#05080c',
    ]);
    for (const hex of hexes) expect(schema.has(hex), hex).toBe(true);
  });

  it('gives keyboard users a visible focus state', () => {
    expect(rules).toContain(':focus-visible');
  });
});

describe('MTT paid places: 10 to 15 percent for a new event', () => {
  const labels = (currentChoice: string, savedChoice?: string) => {
    render(
      <select aria-label="Payout" defaultValue={currentChoice}>
        <MttPayoutDepthOptions currentChoice={currentChoice} savedChoice={savedChoice} />
      </select>
    );
    const out = within(screen.getByRole('combobox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    cleanup();
    return out;
  };

  it('does not offer 20 percent to a new event', () => {
    expect(labels('payout3')).toEqual(['Top 10% Of Field', 'Top 15% Of Field (Standard)']);
    expect(labels('payout1')).toEqual(['Top 10% Of Field', 'Top 15% Of Field (Standard)']);
  });

  it('keeps a saved 20 percent selectable for that event, even after moving off it', () => {
    expect(labels('payout20')).toContain('Top 20% Of Field');
    expect(labels('payout1', 'payout20')).toContain('Top 20% Of Field');
  });
});
