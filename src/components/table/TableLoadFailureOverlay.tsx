import { useNavigate } from 'react-router-dom';
import { SpadeConsole } from '../console/SpadeConsole';
import './TableLoadFailureOverlay.css';

interface TableLoadFailureOverlayProps {
  tableLoadFailure: 'missing' | 'unreachable';
  exitDestination: () => string;
}

/**
 * ON THE MASTER (2026-09-09, #ClubArenaConsole). This was 90 lines of inline
 * style - a navy box with a 14px radius and two CSS pills - shown at the worst
 * possible moment, when a table a player was trying to sit at has gone. It is
 * the spade console now, and it says the same two things it always said: a
 * closed table charged nothing and took no seat, and an unreachable one is
 * probably the connection. TRY AGAIN only appears when trying again can work.
 */
export function TableLoadFailureOverlay({
  tableLoadFailure,
  exitDestination,
}: TableLoadFailureOverlayProps) {
  const navigate = useNavigate();
  const missing = tableLoadFailure === 'missing';

  return (
    <div className="table-load-failure-overlay" role="alert">
      <div className="table-load-failure-box ac-popup">
        <SpadeConsole
          as="div"
          eyebrow="The Table"
          title={missing ? 'Table Closed' : 'Cannot Reach It'}
          titleId="table-load-failure-title"
          pill={missing ? 'Gone' : 'Offline'}
          pillInk={missing ? 'muted' : 'red'}
          /* TWO ACTIONS OR NONE. The foot paints BOTH plates, so handing it
             one action leaves an empty painted button beside it - which reads
             as broken, not as spare. A surface with a single way out uses the
             flat cap and prints that one way out as a lit word on the glass,
             the same control Club Rules uses for Copy and Retry. */
          foot={missing ? 'foot' : undefined}
          plates={
            missing
              ? undefined
              : {
                  secondary: {
                    label: 'Back To Lobby',
                    onClick: () => navigate(exitDestination()),
                  },
                  primary: {
                    label: 'Try Again',
                    ink: 'white',
                    onClick: () => window.location.reload(),
                  },
                }
          }
        >
          <p className="sc-copy sc-copy--center table-load-failure__body">
            {missing
              ? 'That Game Has Finished And The Table Was Taken Down. Nothing Was Charged And No Seat Was Taken.'
              : 'We Could Not Load This Table After Five Tries. Your Connection May Be Down.'}
          </p>
          {missing && (
            <button
              type="button"
              className="table-load-failure__way-out sc-ink--blue"
              onClick={() => navigate(exitDestination())}
            >
              Back To Lobby
            </button>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}

export default TableLoadFailureOverlay;
