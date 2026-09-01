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
  const form = fs.readFileSync(
    path.join(process.cwd(), 'src', 'pages', 'TableConfigPage.tsx'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(process.cwd(), 'src', 'pages', 'TableConfigPage.css'),
    'utf8'
  );

  it('Uses An Isolated Conventional Switch With A Visible On Or Off Status', () => {
    expect(form).toContain('className="table-config-switch"');
    expect(form).toContain('role="switch"');
    expect(form).toContain("{value ? 'On' : 'Off'}");
    expect(form).not.toContain('className="toggle-switch"');
    expect(css).toContain('.table-config-switch__track');
    expect(css).toContain('width: 52px');
    expect(css).toContain('height: 28px');
  });

  it('Explains The Hands Interval Without An Unexplained N', () => {
    expect(form).not.toContain('Every N Hands');
    expect(form).toContain('Every Set Number Of Hands');
    expect(form).toContain('Bomb Pot Hand Interval');
    expect(form).toContain('th Dealt Hand Is A Bomb Pot.');
  });

  it('Leaves No Passive Tooltip Spans On The Create-Table Page', () => {
    expect(form).not.toContain('tooltip-icon');
    expect(form).not.toMatch(/title=.{0,80}\?/);
  });
});
