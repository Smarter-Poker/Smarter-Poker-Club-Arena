import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import haptic from '../../services/HapticService';
import { PlayerSearchService, type MemberLiveTable } from '../../services/PlayerSearchService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { titleCase } from '../../utils/titleCase';
import { WatchAtTableButton } from './WatchAtTableButton';
import { withStakes } from '../../utils/tableEyebrow';

/**
 * WATCH AT TABLE ON THE PLAYER RECORD (Dan 2026-10-16)
 *
 * "WHEN YOU ARE INSIDE OF PLAYER MANAGEMENT, AND THE PLAYER IS 'AT A TABLE'
 * THERE SHOULD BE A BUTTON TO EASILY CLICK TO BE REDIRECTED AND WATCH THEM."
 *
 * The record already knows the player is seated (ca_club_member_detail's
 * presence.is_seated); this finds WHICH table, prints the painted Watch At
 * Table shell, and on a tap revalidates access with the same
 * fn_get_table_watch_access the Find A Player locator uses before routing to
 * the observer view. A seat the viewer cannot read, or a table that closed in
 * the meantime, renders nothing rather than a button that would be refused.
 */
export interface MemberWatchAtTableProps {
  clubUuid: string;
  memberUserId: string;
  /** presence.is_seated from the record; nothing is fetched while false. */
  seated: boolean;
  /** Printed instead while no live table is known. */
  fallback?: ReactNode;
}

export default function MemberWatchAtTable({
  clubUuid,
  memberUserId,
  seated,
  fallback = null,
}: MemberWatchAtTableProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [table, setTable] = useState<MemberLiveTable | null>(null);
  const [verifying, setVerifying] = useState(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    busyRef.current = false;
    setVerifying(false);
    setTable(null);
    if (!seated || !clubUuid || !memberUserId) return;
    PlayerSearchService.getMemberLiveTable(memberUserId, clubUuid)
      .then((live) => {
        if (generationRef.current === generation) setTable(live);
      })
      .catch((error) => {
        if (generationRef.current === generation) {
          reportError(error, 'MemberWatchAtTable.LiveTable');
        }
      });
    return () => {
      generationRef.current += 1;
    };
  }, [clubUuid, memberUserId, seated]);

  if (!table) return <>{fallback}</>;

  const watch = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const generation = generationRef.current;
    setVerifying(true);
    try {
      const access = await PlayerSearchService.getTableWatchAccess(table.table_id, memberUserId);
      if (generationRef.current !== generation) return;
      if (access.can_watch) {
        haptic.success();
        navigate(`/table/${table.table_id}?observer=1`);
        return;
      }
      haptic.error();
      if (!access.found) {
        setTable(null);
        toast.error('This Player Has Left The Table.');
      } else if (access.action === 'observers_restricted') {
        toast.error('This Table Does Not Allow Observers.');
      } else {
        toast.error('This Game Is Not Available To Watch.');
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      reportError(error, 'MemberWatchAtTable.WatchAccess');
      toast.error('Could Not Verify Table Access. Please Try Again.');
    } finally {
      if (generationRef.current === generation) {
        busyRef.current = false;
        setVerifying(false);
      }
    }
  };

  const name = titleCase(table.name);
  const stakes = titleCase(table.stakes);

  return (
    <div className="mm-watch">
      <WatchAtTableButton
        onClick={() => void watch()}
        disabled={verifying}
        socket={table.is_tournament ? 'MTT' : 'Cash'}
        eyebrow={withStakes(name, stakes)}
        title={verifying ? 'Verifying Access' : 'Watch At Table'}
        ariaLabel={`Watch At Table, ${name}`}
      />
    </div>
  );
}
