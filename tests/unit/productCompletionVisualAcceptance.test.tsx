/**
 * VISUAL ACCEPTANCE OF THE PRODUCT COMPLETION SURFACES (2026-09-24).
 *
 * Each case pins a defect found by rendering the new surfaces headless at
 * 393px and 1440px (docs/handoffs/club-arena-product-completion/
 * VISUAL-ACCEPTANCE.md). Geometry cannot be measured in happy-dom, so where a
 * defect was a layout rule the case pins the rule that fixed it; where it was
 * markup or words, the case renders the component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../../src/lib/supabase';
import SeatSlot from '../../src/components/table/SeatSlot';
import RescheduleStageControl from '../../src/components/tournament/RescheduleStageControl';
import { resetPlatformCapabilityCache } from '../../src/hooks/usePlatformCapability';
import { scheduleZoneLabel } from '../../src/utils/scheduleTimeZone';

vi.mock('@/components/table/CardImage', () => ({
  default: () => <span />,
  CardImage: () => <span />,
  CardBack: () => <span />,
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = plain.indexOf(`${selector} {`);
  expect(at, `${selector} is declared`).toBeGreaterThanOrEqual(0);
  return plain.slice(at, plain.indexOf('}', at));
};

afterEach(cleanup);

describe('the killer seat keeps its position badge', () => {
  const player = {
    id: 'u3',
    name: 'Killer',
    stack: 500,
    status: 'active' as const,
    showCards: false,
    isHero: false,
  };

  it('draws the kill marker and the position badge side by side in one row', () => {
    const { container } = render(
      <SeatSlot
        seatNumber={3}
        player={player}
        position={'UTG+1' as never}
        killMarker="Kill Blind"
        isActive={false}
        lastAction={null as never}
      />
    );
    const row = container.querySelector('.seat__corner-badges');
    expect(row).not.toBeNull();
    expect([...row!.children].map((c) => c.textContent)).toEqual(['Kill Blind', 'UTG+1']);
  });

  it('leaves every other seat exactly as it was: a lone position badge, no row', () => {
    const { container } = render(
      <SeatSlot
        seatNumber={3}
        player={player}
        position={'SB' as never}
        killMarker={null}
        isActive={false}
        lastAction={null as never}
      />
    );
    expect(container.querySelector('.seat__corner-badges')).toBeNull();
    expect(container.querySelector('.seat__position-badge--sb')?.textContent).toBe('SB');
  });

  it('the row is a flex row and the two badges flow in it, never absolutely over each other', () => {
    const css = read('src/components/table/SeatSlot.css');
    expect(rule(css, '.seat__corner-badges')).toMatch(/display:\s*flex/);
    expect(rule(css, '.seat__corner-badges > .seat__position-badge')).toMatch(/position:\s*static/);
    expect(rule(css, '.seat__kill-badge')).toMatch(/width:\s*min-content/);
  });
});

describe('a long rules value wraps instead of printing over its label', () => {
  it('the label column never narrows below its longest word', () => {
    expect(rule(read('src/components/table/GameRulesModal.css'), '.rules-modal__item')).toMatch(
      /grid-template-columns:\s*minmax\(min-content,\s*1fr\)\s+auto/
    );
  });

  it('the multi-day line on the tournament card stacks, and its start time wraps', () => {
    const tsx = read('src/components/tournament/TournamentLobbyCard.tsx');
    expect(tsx).toMatch(
      /tournament\.status === 'bagged' && stageNote && \(\s*<div className=\{`\$\{styles\.row\} \$\{styles\.rowStacked\}`\}>/
    );
    const css = read('src/components/tournament/TournamentLobbyCard.module.css');
    expect(rule(css, '.rowStacked')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule(css, '.rowStacked .value')).toMatch(/white-space:\s*normal/);
  });

  it('the club allowance line wraps inside the phone instead of running off both edges', () => {
    expect(
      rule(read('src/components/modals/CreateClubModal.module.css'), '.pageFooter .status')
    ).toMatch(/white-space:\s*normal/);
  });
});

describe('controls wear the page ink, not browser defaults', () => {
  it('the kill pot chips and rule sentence are inset from the panel rail', () => {
    const css = read('src/components/cash/CashGameCreateFlow.css');
    expect(rule(css, '.cash-create__promise > .cash-create__chips')).toMatch(
      /padding:\s*10px 12px/
    );
    expect(rule(css, '.cash-create__promise > .cash-create__note')).toMatch(/padding:\s*10px 12px/);
  });

  it('the Day Schedule fields use the form field class and its buttons are styled', () => {
    const tsx = read('src/components/tournament/DayScheduleEditor.tsx');
    expect(tsx.match(/className="config-datetime"/g)?.length).toBe(2);
    expect(
      rule(read('src/components/tournament/DayScheduleEditor.css'), '.day-schedule__actions button')
    ).toMatch(/border:\s*2px solid #1877f2/);
  });

  it('the reschedule fields are dark board fields', () => {
    expect(
      rule(
        read('src/components/tournament/RescheduleStageControl.css'),
        '.md-reschedule__field input'
      )
    ).toMatch(/background:\s*#05080c/);
  });

  it("the union schedule card's button has a fill that exists at runtime", () => {
    const join = rule(read('src/pages/UnionDetailPage.module.css'), '.joinButton');
    // --accent / --accent-dark are defined only in globals.css, which main.tsx
    // does not import: a background built from them paints nothing.
    expect(join).not.toMatch(/var\(--accent(-dark)?\)/);
    expect(join).toMatch(/color:\s*#f4f7fb/);
  });

  it('the refusals under the tournament form keep their red', () => {
    expect(read('src/components/club/CreateTournamentModal.tsx')).toContain(
      'className={styles.validationSummary}'
    );
    expect(
      rule(read('src/components/club/CreateTournamentModal.module.css'), '.validationSummary p')
    ).toMatch(/color:\s*inherit/);
  });
});

describe('a zone prints as a place, not an id', () => {
  it('scheduleZoneLabel drops the underscore and says UTC without a zone', () => {
    expect(scheduleZoneLabel('America/Argentina/Buenos_Aires')).toBe(
      'America/Argentina/Buenos Aires'
    );
    expect(scheduleZoneLabel('America/Chicago')).toBe('America/Chicago');
    expect(scheduleZoneLabel(null)).toBe('UTC');
  });

  describe('Reschedule Day 2', () => {
    beforeEach(() => {
      resetPlatformCapabilityCache();
      vi.mocked(supabase.rpc).mockImplementation(((fn: string) => {
        if (fn === 'fn_platform_capabilities') {
          return Promise.resolve({
            data: [
              {
                id: 'tournament.multi_day.single_flight',
                version: 'multi-day-v1',
                title: 'Multi-Day Tournaments',
                scope: 'tournament',
                variants: [],
                compatibility: {},
                readiness: 'deployed',
                available: true,
              },
            ],
            error: null,
          });
        }
        if (fn === 'fn_tournament_stage_view') {
          return Promise.resolve({
            data: {
              ok: true,
              tournament_id: 't',
              status: 'BAGGED',
              plan: { rule_version: 'multi-day-v1', time_zone: 'America/New_York', stage_count: 2 },
              stages: [],
              current_stage: { stage_no: 1, day_no: 1, state: 'bagged' },
              next_start: {
                stage_no: 2,
                day_no: 2,
                scheduled_start_utc: '2026-10-03T17:00:00Z',
                time_zone: 'America/New_York',
                schedule_generation: 1,
                state: 'scheduled',
              },
              bag: null,
              my_bag: null,
              my_seat: null,
              chip_leaders: [],
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }) as never);
    });

    it('names the plan zone without the underscore', async () => {
      render(<RescheduleStageControl tournamentId="t" status="BAGGED" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Reschedule Day 2' }));
      await waitFor(() => expect(screen.getByText('Starts At (America/New York)')).toBeTruthy());
    });
  });
});
