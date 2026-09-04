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

  it('Explains The Bomb Schedule Without An Unexplained N', () => {
    expect(form).not.toContain('Every N Hands');
    expect(flow).not.toContain('Every N Hands');
    expect(flow).toContain('Every 15 Minutes');
    expect(flow).toContain('Every Orbit');
  });

  it('Leaves No Passive Tooltip Spans On The Create-Table Page', () => {
    for (const src of [form, controls, flow]) {
      expect(src).not.toContain('tooltip-icon');
      expect(src).not.toMatch(/title=.{0,80}\?/);
    }
  });
});
