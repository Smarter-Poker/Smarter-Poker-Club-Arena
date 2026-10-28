import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/useUserStore';
import { useToast } from '../common/Toast';
import { titleCase } from '../../utils/titleCase';
import { reportError } from '../../utils/errorReporter';
import { masterBus } from '../../core/MasterBus';
import { launchMidwayPlo5 } from '../../services/MidwayPlo5LaunchService';
import { cashGameCreateRefusalText } from '../../config/cashGames';
import {
  MIDWAY_PLO5_CLUB_ID,
  MIDWAY_PLO5_LAUNCH_ID,
  MIDWAY_PLO5_LINEUP,
} from '../../config/midwayPlo5Launch';
import {
  GAME_CREATED_MEMBERS_ONLY,
  GAME_CREATED_SEATED_ONLY,
  GAME_CREATED_STILL_STARTING,
  wakeTableEngine,
} from './CashGameCreateFlow';
import './CashGameCreateFlow.css';

export default function MidwayPlo5Launch({
  clubId,
  launchId,
  canBuildHere,
  checkingAccess = false,
  deniedMessage,
  onSaved,
}: {
  clubId: string;
  launchId: string;
  canBuildHere: boolean;
  checkingAccess?: boolean;
  deniedMessage?: string | null;
  onSaved?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const userId = useUserStore((state) => state.user?.id ?? null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const validIntent = launchId === MIDWAY_PLO5_LAUNCH_ID && clubId === MIDWAY_PLO5_CLUB_ID;
  const refusal = !validIntent
    ? 'This Approved Launch Is Not Available Here'
    : checkingAccess
      ? 'Checking Your Launch Access'
      : !canBuildHere
        ? deniedMessage || 'You Cannot Create Games In This Club'
        : !userId
          ? 'Please Sign In To Continue'
          : null;

  const start = async () => {
    if (refusal || !userId || inFlight.current) return;
    const owner = userId;
    const stillOwner = () => mounted.current && useUserStore.getState().user?.id === owner;
    const assertOwner = () => {
      if (!stillOwner()) throw new Error('The Launch Session Changed');
    };
    inFlight.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const result = await launchMidwayPlo5(clubId, assertOwner);
      assertOwner();
      masterBus.emit('TABLE_CREATED', {
        tableId: result.tableId,
        clubId: MIDWAY_PLO5_CLUB_ID,
      });
      const wake = await wakeTableEngine(result.tableId);
      assertOwner();
      if (wake.status === 'awake') {
        toast.success('Game Created And Started');
        navigate(`/table/${result.tableId}`);
      } else {
        const message =
          wake.status === 'not_awake'
            ? GAME_CREATED_STILL_STARTING
            : wake.code === 'CLUB_MEMBERSHIP_REQUIRED'
              ? GAME_CREATED_MEMBERS_ONLY
              : GAME_CREATED_SEATED_ONLY;
        setStatus(message);
        toast.info(message);
        if (onSaved) onSaved();
        else navigate(`/clubs/${clubId}`);
      }
    } catch (error) {
      if (stillOwner()) {
        reportError(error, 'MidwayPlo5Launch.start');
        const rawMessage =
          error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
        const missingContract =
          error && typeof error === 'object' && 'code' in error && error.code === 'PGRST202';
        const approvedRefusal = missingContract
          ? 'The Approved Launch Is Not Available Yet'
          : /LIVE_SESSION_REQUIRED/.test(rawMessage)
            ? 'Please Sign In Again'
            : /NOT_AUTHORIZED/.test(rawMessage)
              ? 'You Cannot Launch Games In Midway Union'
              : /HORSE_NO_LONGER_ELIGIBLE/.test(rawMessage)
                ? 'A Selected Player Is No Longer Available'
                : /ARRIVAL_REQUEST_MISMATCH/.test(rawMessage)
                  ? 'This Launch Request Belongs To Another Account Or Lineup'
                  : /ARRIVAL_INTENT_INVALID/.test(rawMessage)
                    ? 'The Approved Lineup Was Refused'
                    : null;
        const message =
          approvedRefusal ||
          cashGameCreateRefusalText(error) ||
          (error instanceof Error ? error.message : null) ||
          'Launch Not Confirmed. Retry Uses The Same Request';
        setStatus(message);
        toast.error(message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="cash-create">
      {refusal ? (
        <p className="cash-create__note" role={checkingAccess ? 'status' : 'alert'}>
          {titleCase(refusal)}
        </p>
      ) : (
        <>
          <section className="cash-create__step">
            <h2 className="cash-create__title">2/5 PLO5 Madness</h2>
            <p className="cash-create__note">
              Midway Union. Six Seats. Automated Main And Feeder Tables.
            </p>
            <p className="cash-create__note">
              Four Selected Players To Start, Then One New Player Every Ten Minutes. Delayed
              Arrivals Never Catch Up In A Burst.
            </p>
            <p className="cash-create__note">
              Humans May Join Normally. Normal Bankroll, Availability, Table Limits And Minimum
              Players Still Apply.
            </p>
          </section>
          <section className="cash-create__step" aria-label="Selected Lineup">
            <h2 className="cash-create__title">Selected Lineup: 20 Players</h2>
            {MIDWAY_PLO5_LINEUP.map((player, index) => (
              <p className="cash-create__note" key={player.id}>
                {index + 1}. {titleCase(player.name)}
              </p>
            ))}
          </section>
          <footer className="config-footer cash-create__footer">
            <button
              className="btn-save"
              type="button"
              disabled={busy}
              onClick={() => (onSaved ? onSaved() : navigate(`/clubs/${clubId}`))}
            >
              Back
            </button>
            <button
              className="btn-start"
              type="button"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? 'Starting...' : 'Start'}
            </button>
          </footer>
        </>
      )}
      {status && (
        <p className="cash-create__note" role="status">
          {titleCase(status)}
        </p>
      )}
    </div>
  );
}
