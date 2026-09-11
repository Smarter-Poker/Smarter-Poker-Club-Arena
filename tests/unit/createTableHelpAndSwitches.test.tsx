/**
 * Create-Table Help And Switch Interaction Contract (2026-08-31).
 *
 * The Old Question Marks Were Passive Spans With A `title` Attribute: They
 * Could Not Be Clicked, Did Nothing On Touch, And Gave Keyboard Users No Help.
 * The Old `.toggle-switch` Label Also Collided With The Arena-Wide Track CSS,
 * Painting A Second Thumb And Pushing The On/Off Text Beyond The Right Edge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { HelpPopover } from '../../src/components/common/HelpPopover';
import {
  CASH_TEMPLATES,
  templatePromiseLines,
  type CashRulesetSnapshot,
  type CashTemplate,
} from '../../src/config/cashGames';

afterEach(cleanup);

describe('Create-Table Help', () => {
  it('Opens On Hover And Closes When Hover Ends', () => {
    render(<HelpPopover label="Cap">Limit The Total Chips In One Hand</HelpPopover>);
    const button = screen.getByRole('button', { name: 'Help: Cap' });

    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip').textContent).toContain('Limit The Total Chips');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Pins On Click Or Tap And Closes With Escape', () => {
    render(<HelpPopover label="No Rathole">Prevent Leaving With Winnings</HelpPopover>);
    const button = screen.getByRole('button', { name: 'Help: No Rathole' });

    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Opens For Keyboard Focus And Uses A Real Button Instead Of A Title Attribute', () => {
    render(<HelpPopover label="Fee">Prize Distribution</HelpPopover>);
    const button = screen.getByRole('button', { name: 'Help: Fee' });

    expect(button.tagName).toBe('BUTTON');
    expect(button.hasAttribute('title')).toBe(false);
    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Create-Table Switch And Bomb-Schedule Markup', () => {
  // 2026-09-04 (Operation Table Stakes, Slice 1): the switch moved verbatim
  // into src/components/table-config/controls.tsx so the New Cash Game flow
  // and the tournament form draw the same one. The bomb schedule on a cash
  // game is now Every 15 Minutes or Every Orbit (OPORD 1.3 section 8), so
  // there is no hands interval to explain on the cash side at all.
  const form = fs.readFileSync(
    path.join(process.cwd(), 'src', 'pages', 'TableConfigPage.tsx'),
    'utf8'
  );
  const controls = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'table-config', 'controls.tsx'),
    'utf8'
  );
  const flow = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'cash', 'CashGameCreateFlow.tsx'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(process.cwd(), 'src', 'pages', 'TableConfigPage.css'),
    'utf8'
  );
  // Where the bomb cadence copy lives now (see the pin below).
  const vocab = fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'cashGames.ts'), 'utf8');

  it('Uses An Isolated Conventional Switch With A Visible On Or Off Status', () => {
    expect(controls).toContain('className="table-config-switch"');
    expect(controls).toContain('role="switch"');
    expect(controls).toContain("{value ? 'On' : 'Off'}");
    expect(controls).not.toContain('className="toggle-switch"');
    expect(form).not.toContain('className="toggle-switch"');
    expect(flow).not.toContain('className="toggle-switch"');
    // Both forms draw THAT switch, not a copy.
    expect(form).toMatch(
      /import \{ Toggle, Slider, NumberField \} from '\.\.\/components\/table-config\/controls'/
    );
    expect(flow).toMatch(/import \{ Slider, Toggle \} from '\.\.\/table-config\/controls'/);
    expect(css).toContain('.table-config-switch__track');
    expect(css).toContain('width: 52px');
    expect(css).toContain('height: 28px');
  });

  /* THE PIN MOVED WITH ITS MECHANISM (2026-09-09, must-move audit lane I).
     This read the cadence strings out of CashGameCreateFlow.tsx, because the
     flow OFFERED a bomb trigger radio. It does not any more: since
     20260909035303 fn_cash_game_create takes the whole bombs object from
     fn_cash_template_defaults and reads nothing the caller sends, so the
     controls were replaced by read-only readouts of the template's promise
     (docs/changelog/2026-09-09-a-classic-game-has-no-antes-and-no-bombs.md).
     The RULE is unchanged and is what is pinned here: a host is told the bomb
     cadence in words, never a bare N. It is now asserted through the function
     that produces the words rather than by grepping a file, so it survives the
     copy moving again. */
  it('Explains The Bomb Schedule Without An Unexplained N', () => {
    expect(form).not.toContain('Every N Hands');
    expect(flow).not.toContain('Every N Hands');
    expect(vocab).not.toContain('Every N Hands');
    expect(vocab).not.toMatch(/Every N\b/);

    const cadence = (template: CashTemplate, bombs: CashRulesetSnapshot['bombs']): string =>
      templatePromiseLines({
        template,
        regular_ante: 'none',
        vpip_floor: 0,
        vpip_window: 10,
        bombs,
      }).find((l) => l.key === 'bombs')!.value;

    // Every template that RUNS bombs spells its cadence out.
    expect(cadence('action', { enabled: true, trigger: 'timed_15m', ante_bb: 2, boards: 2 })).toBe(
      'Double Board, 2 BB Ante, Every 15 Minutes'
    );
    expect(
      cadence('madness', { enabled: true, trigger: 'every_orbit', ante_bb: 3, boards: 2 })
    ).toBe('Double Board, 3 BB Ante, Every Orbit');
    // And the one that does not says so, rather than leaving the row blank.
    expect(cadence('classic', { enabled: false, trigger: null, ante_bb: null, boards: null })).toBe(
      'No Bomb Pots'
    );

    // The template card a host picks from says the same thing, in the same words.
    const blurb = Object.fromEntries(CASH_TEMPLATES.map((t) => [t.id, t.blurb]));
    expect(blurb.action).toContain('Every 15 Minutes');
    expect(blurb.madness).toContain('Every Orbit');
    expect(blurb.classic).toContain('No Bombs');
    for (const t of CASH_TEMPLATES) expect(t.blurb).not.toMatch(/\bN\b/);
  });

  it('Leaves No Passive Tooltip Spans On The Create-Table Page', () => {
    for (const src of [form, controls, flow]) {
      expect(src).not.toContain('tooltip-icon');
      expect(src).not.toMatch(/title=.{0,80}\?/);
    }
  });
});
