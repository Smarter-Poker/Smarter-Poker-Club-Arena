/**
 * MULTI-DAY: STAGE SCHEDULE, YOUR BAG, CHIP LEADERS, YOUR DAY 2 SEAT.
 *
 * Shown on the tournament Overview only when BOTH gates say so: the platform
 * capability `tournament.multi_day.single_flight` is available, and
 * fn_tournament_stage_view reports a sealed plan for this event. Either one
 * missing, this renders nothing at all.
 *
 * NEVER MOVES THE PLAYER (CLAUDE.md 10.6). "Your Day 2 Seat" is information
 * with an Open Table button; the only navigation in this file is that button's
 * onClick. No effect, timer or status change here ever opens, switches or
 * focuses a table (tests/no-auto-table-switch.law.test.ts).
 *
 * Horses and humans read the same view: the leaders list is display names and
 * stacks, with no horse flag in the data to branch on (CLAUDE.md 10.5).
 */
import { useNavigate } from 'react-router-dom';
import { useTournamentStageView } from '../../../hooks/useTournamentStageView';
import type { StageRow, StageState } from '../../../services/TournamentStageService';
import {
  dayCompleteLabel,
  formatStageStart,
  isBaggedStatus,
  nextDayStartsLabel,
} from '../../../utils/multiDaySchedule';
import '../../../styles/tournament-lobby-3d.css';
import './MultiDayStagePanel.css';

const STATE_LABEL: Record<StageState, string> = {
  planned: 'Not Started',
  running: 'Running',
  day_ending: 'Final Hands',
  bagged: 'Complete',
  scheduled: 'Scheduled',
  resuming: 'Seating',
  closed: 'Complete',
};

function stageWhen(stage: StageRow, zone: string): string {
  if (stage.stageNo === 1) {
    return stage.endAfterLevel !== null
      ? `Ends After Level ${stage.endAfterLevel.toLocaleString()}`
      : 'Plays To A Winner';
  }
  const start = formatStageStart(stage.scheduledStartUtc, zone) ?? 'Start Time Unavailable';
  return stage.endAfterLevel !== null
    ? `Starts ${start}, Ends After Level ${stage.endAfterLevel.toLocaleString()}`
    : `Starts ${start}, Plays To A Winner`;
}

/** The one way this panel moves anybody: a tap. Rendered only with a seat,
    so an Overview mounted outside a router never needs one until then. */
function OpenTableButton({ tableId }: { tableId: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="md-stage__open" onClick={() => navigate(`/table/${tableId}`)}>
      Open Table
    </button>
  );
}

export default function MultiDayStagePanel({
  tournamentId,
  status,
}: {
  tournamentId: string;
  status: string | null | undefined;
}) {
  const { view } = useTournamentStageView(tournamentId, status ?? null);
  if (!view || !view.plan) return null;

  const zone = view.plan.timeZone;
  const bagged = isBaggedStatus(view.status);
  const next = view.nextStart;
  const headline = bagged
    ? dayCompleteLabel(view.currentStage?.dayNo)
    : view.currentStage && view.currentStage.state !== 'planned'
      ? `Day ${view.currentStage.dayNo} ${STATE_LABEL[view.currentStage.state]}`
      : `${view.plan.stageCount.toLocaleString()} Day Event`;
  const nextLine = next ? nextDayStartsLabel(next.dayNo, next.scheduledStartUtc, zone) : null;

  return (
    <section className="tl-panel md-stage" aria-label="Multi-Day Schedule">
      <div className="tl-section-head">
        <h3>Stage Schedule</h3>
        <span className="tl-section-note">{headline}</span>
      </div>
      {nextLine && (
        <p className="md-stage__next" role="status">
          {nextLine}
        </p>
      )}
      <ol className="md-stage__days">
        {view.stages.map((stage) => (
          <li key={stage.stageNo} className="md-stage__day">
            <span className="md-stage__dayname">Day {stage.dayNo.toLocaleString()}</span>
            <span className="md-stage__when">{stageWhen(stage, zone)}</span>
            <span className="md-stage__state">{STATE_LABEL[stage.state]}</span>
          </li>
        ))}
      </ol>

      {view.mySeat && (
        <div className="md-stage__seat">
          <span className="md-stage__label">
            Your Day {view.mySeat.dayNo.toLocaleString()} Seat
          </span>
          <span className="md-stage__value">
            {view.mySeat.tableName ?? 'Your Table'}, Seat {view.mySeat.seatNumber.toLocaleString()}
          </span>
          <OpenTableButton tableId={view.mySeat.tableId} />
        </div>
      )}

      {view.myBag && (
        <div className="md-stage__bag" aria-label="Your Bag">
          <span className="md-stage__label">Your Bag</span>
          <span className="md-stage__value">{view.myBag.stack.toLocaleString()} Chips</span>
          {view.myBag.bountyHead > 0 && (
            <span className="md-stage__sub">Bounty {view.myBag.bountyHead.toLocaleString()}</span>
          )}
        </div>
      )}

      {bagged && view.chipLeaders.length > 0 && (
        <div className="md-stage__leaders">
          <span className="md-stage__label">Chip Leaders</span>
          <ol className="md-stage__leaderlist" aria-label="Chip Leaders">
            {view.chipLeaders.map((leader) => (
              <li key={leader.rank} className="md-stage__leader">
                <span className="md-stage__rank">{leader.rank.toLocaleString()}</span>
                <span className="md-stage__name">{leader.displayName}</span>
                <span className="md-stage__stack">{leader.stack.toLocaleString()}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
