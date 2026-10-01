import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  clubWelcomePackageService,
  welcomePackageImpactHasNoBlockers,
  type ClubWelcomePackageResetImpact,
  type ClubWelcomePackageState,
} from '../../services/ClubWelcomePackageService';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import { uuid } from '../../utils/uuid';
import { SpadeConsole } from '../console/SpadeConsole';
import './ClubWelcomePackage.css';

interface Props {
  clubId: string;
  clubName: string;
}

const DAILY_TOURNAMENT_SLOT = 'daily_25_freezeout_1900';

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return count === 1 ? singular : pluralWord;
}

function blockerText(impact: ClubWelcomePackageResetImpact): string {
  const blockers = [
    [impact.blocking.activeSeats, 'Active Seats'],
    [impact.blocking.openSessions, 'Open Sessions'],
    [impact.blocking.waitingPlayers, 'Waiting Players'],
    [impact.blocking.pendingMoves, 'Pending Moves'],
    [impact.blocking.registeredPlayers, 'Registered Players'],
    [impact.blocking.runningTournaments, 'Running Tournaments'],
    [impact.blocking.executingCommands, 'Executing Commands'],
    [impact.blocking.handHistory, 'Recorded Hands'],
  ] as const;
  const active = blockers.filter(([count]) => count > 0);
  return active.length === 0
    ? 'Removal Is Not Authorized By The Server'
    : active.map(([count, label]) => `${compactChips(count)} ${label}`).join(', ');
}

function WelcomePackageResetDialog({
  clubId,
  clubName,
  operationIdRef,
  onClose,
  onRemoved,
}: {
  clubId: string;
  clubName: string;
  operationIdRef: MutableRefObject<string | null>;
  onClose: () => void;
  onRemoved: (completedAt: string) => void;
}) {
  const confirmationName = titleCase(clubName);
  const [impact, setImpact] = useState<ClubWelcomePackageResetImpact | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const requestGenerationRef = useRef(0);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, '#welcome-package-confirmation');

  const readImpact = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setImpact(null);
    setError('');
    try {
      const next = await clubWelcomePackageService.getResetImpact(clubId);
      if (requestGenerationRef.current === generation) setImpact(next);
    } catch (caught) {
      if (requestGenerationRef.current !== generation) return;
      reportError(caught, 'ClubWelcomePackage.reset_impact_failed');
      setError('Removal Impact Could Not Be Confirmed');
    }
  }, [clubId]);

  useEffect(() => {
    void readImpact();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [readImpact]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !removing) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = priorOverflow;
    };
  }, [onClose, removing]);

  const safeImpact = impact ? welcomePackageImpactHasNoBlockers(impact) : false;
  const confirmed = confirmation === confirmationName;
  const remove = async () => {
    if (!safeImpact || !confirmed || removing) return;
    setRemoving(true);
    setError('');
    const operationId = operationIdRef.current ?? uuid();
    operationIdRef.current = operationId;
    try {
      /* The preview is never treated as a lock. Re-read immediately before
         the one atomic mutation and fail closed if any server blocker moved. */
      const currentImpact = await clubWelcomePackageService.getResetImpact(clubId);
      if (!welcomePackageImpactHasNoBlockers(currentImpact)) {
        setImpact(currentImpact);
        setError('Removal Is No Longer Safe. Nothing Was Removed');
        return;
      }
      const receipt = await clubWelcomePackageService.remove(clubId, operationId);
      operationIdRef.current = null;
      onRemoved(receipt.completedAt);
    } catch (caught) {
      reportError(caught, 'ClubWelcomePackage.remove_failed', { operationId });
      /* Keep the operation id for every retry. A lost response can be a
         committed operation; only the server's replay receipt settles it. */
      setError('Removal Could Not Be Confirmed. Use The Same Action To Check Again');
    } finally {
      setRemoving(false);
    }
  };

  const resetSummary = impact
    ? `${compactChips(impact.removable.cashGames)} ${plural(
        impact.removable.cashGames,
        'Cash Game'
      )} And ${compactChips(impact.removable.tournaments)} ${plural(
        impact.removable.tournaments,
        'Tournament'
      )} Will Be Removed`
    : 'Checking The Server Impact';

  return createPortal(
    <div className="club-welcome-reset__overlay" onClick={removing ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="club-welcome-reset ac-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="club-welcome-reset-title"
        aria-describedby="club-welcome-reset-description"
        aria-busy={removing || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <SpadeConsole
          as="div"
          crest="club"
          eyebrow="Opening Welcome Package"
          title="Start From Zero"
          titleId="club-welcome-reset-title"
          pill="Remove"
          pillInk="red"
          onClose={removing ? undefined : onClose}
          plates={{
            secondary: {
              label: 'Cancel',
              onClick: onClose,
              disabled: removing,
            },
            primary: {
              label: removing ? 'Removing' : 'Start From Zero',
              ink: 'red',
              onClick: remove,
              disabled: !safeImpact || !confirmed || removing,
            },
          }}
        >
          <div id="club-welcome-reset-description" className="club-welcome-reset__body">
            <p className="sc-copy sc-copy--center">{resetSummary}</p>
            {impact && !safeImpact && (
              <p className="club-welcome-reset__refusal" role="status">
                {blockerText(impact)}
              </p>
            )}
            {error && (
              <p className="club-welcome-reset__refusal" role="alert">
                {error}
              </p>
            )}
            <p className="club-welcome-reset__protection">
              Club Bank, Player Chips, And Memberships Will Not Change
            </p>
            <label htmlFor="welcome-package-confirmation">
              Type <strong>{confirmationName}</strong> To Confirm
            </label>
            <input
              id="welcome-package-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={removing}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </SpadeConsole>
      </div>
    </div>,
    document.body
  );
}

export default function ClubWelcomePackage({ clubId, clubName }: Props) {
  const [state, setState] = useState<ClubWelcomePackageState | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [removedAt, setRemovedAt] = useState<string | null>(null);
  /* This belongs to the club action, not the dialog mount. Closing and
     reopening after an unknown outcome must reuse the same server key. */
  const resetOperationIdRef = useRef<string | null>(null);

  useEffect(() => {
    resetOperationIdRef.current = null;
  }, [clubId]);

  const read = useCallback(async () => {
    setReadFailed(false);
    try {
      const next = await clubWelcomePackageService.get(clubId);
      setState(next);
    } catch (caught) {
      reportError(caught, 'ClubWelcomePackage.read_failed');
      setState(null);
      setReadFailed(true);
    }
  }, [clubId]);

  useEffect(() => {
    let current = true;
    void clubWelcomePackageService
      .get(clubId)
      .then((next) => {
        if (current) setState(next);
      })
      .catch((caught) => {
        if (!current) return;
        reportError(caught, 'ClubWelcomePackage.read_failed');
        setReadFailed(true);
      });
    return () => {
      current = false;
    };
  }, [clubId]);

  const activeItems = useMemo(
    () => state?.items.filter((item) => item.retiredAt === null) ?? [],
    [state]
  );
  const cashGameCount = activeItems.filter(
    (item) => item.entityKind === 'cash_game' && item.slotKey.startsWith('classic_')
  ).length;
  const tournamentCount = activeItems.filter(
    (item) => item.entityKind === 'tournament_schedule' && item.slotKey === DAILY_TOURNAMENT_SLOT
  ).length;
  const mayRemove = state?.status === 'provisioned' && activeItems.length > 0;

  if (!readFailed && (!state || !state.eligible || state.status === 'not_eligible')) return null;

  return (
    <SpadeConsole
      as="section"
      className="club-welcome"
      aria-labelledby="club-welcome-title"
      eyebrow="Club Opening"
      title="Opening Welcome Package"
      titleId="club-welcome-title"
      subtitle="Server Confirmed Club Setup"
      pill="Welcome"
      pillInk="blue"
      crest="diamond"
      foot="foot"
    >
      <div className="club-welcome__heading">
        <span>Package Receipt</span>
        {readFailed && (
          <button type="button" onClick={() => void read()}>
            Retry Status
          </button>
        )}
      </div>

      {readFailed ? (
        <p className="club-welcome__notice" role="alert">
          Welcome Package Status Is Unavailable. Removal Is Locked
        </p>
      ) : state?.status === 'not_configured' ? (
        <p className="club-welcome__notice">Welcome Package Configuration Is Not Available Yet</p>
      ) : state?.status === 'reset' || removedAt ? (
        <p className="club-welcome__notice is-complete">Preloaded Games Removed</p>
      ) : (
        <>
          <div className="club-welcome__rows">
            <div>
              <span>Bad Beat Jackpot</span>
              <strong>{state?.economics?.bbjEnabled ? 'Enabled' : 'Not Enabled'}</strong>
            </div>
            <div>
              <span>Spins</span>
              <strong>{state?.economics?.spinsEnabled ? 'Enabled' : 'Not Enabled'}</strong>
            </div>
            <div>
              <span>Diamond Spins</span>
              <strong className="is-acceptance">
                {state?.economics?.diamondSpinsStatus === 'owner_acceptance_required'
                  ? 'Owner Acceptance Required'
                  : 'Not Enabled'}
              </strong>
            </div>
            <div>
              <span>Classic 50¢ / $1 Games</span>
              <strong>
                {cashGameCount > 0 ? `${compactChips(cashGameCount)} Preloaded` : 'Not Preloaded'}
              </strong>
            </div>
            <div>
              <span>Daily $25 Freezeout · 7 PM UTC</span>
              <strong>{tournamentCount > 0 ? 'Preloaded' : 'Not Preloaded'}</strong>
            </div>
          </div>
          {mayRemove && (
            <button
              type="button"
              className="club-welcome__remove"
              onClick={() => setResetOpen(true)}
            >
              Remove All Preloaded Games And Start From Zero
            </button>
          )}
        </>
      )}

      {resetOpen && (
        <WelcomePackageResetDialog
          clubId={clubId}
          clubName={clubName}
          operationIdRef={resetOperationIdRef}
          onClose={() => setResetOpen(false)}
          onRemoved={(completedAt) => {
            setRemovedAt(completedAt);
            setResetOpen(false);
            void read();
          }}
        />
      )}
    </SpadeConsole>
  );
}
