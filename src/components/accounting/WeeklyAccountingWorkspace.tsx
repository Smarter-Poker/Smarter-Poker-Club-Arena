import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useCashoutScope } from '../../hooks/useCashoutScope';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { resolveUnionUUID } from '../../utils/unionIdResolver';
import {
  accountingWeekEndingOn,
  accountingWeekEndDate,
  latestClosedAccountingWeek,
  isAccountingUUID,
  type AccountingWeek,
  type AccountingScopeKind,
} from '../../services/AccountingObservationService';
import { SettlementService, type SettlementPeriod } from '../../services/SettlementService';
import { AccountingRunStatus } from '../agent/UnionAccountingRunStatus';
import ClubWeeklyAccountingSummary from './ClubWeeklyAccountingSummary';

function UnionPeriodRecords({ unionId, actorId }: { unionId: string; actorId: string }) {
  const scope = useCashoutScope(actorId, `union-period-records:${unionId}`);
  const sequence = useRef(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    scope: () => boolean;
    read: number;
    rows: SettlementPeriod[] | null;
  } | null>(null);
  useEffect(() => {
    const read = ++sequence.current;
    const current = () => scope() && sequence.current === read;
    setResult(null);
    void SettlementService.getPeriodHistory(12, {
      scopeKind: 'union',
      scopeId: unionId,
      actorId,
      isCurrent: current,
    })
      .then((rows) => {
        if (current()) setResult({ scope, read, rows });
      })
      .catch(() => {
        if (current()) setResult({ scope, read, rows: null });
      });
    return () => {
      ++sequence.current;
    };
  }, [unionId, actorId, scope, revision]);
  const visible =
    scope() && result?.scope === scope && result.read === sequence.current ? result : null;
  return (
    <section aria-label="Union Period Records">
      <h2>Recorded Union Periods</h2>
      <p>
        Latest Up To 12 Records. Recorded Period Status Alone Does Not Prove Payment Or Complete
        Weekly Accounting.
      </p>
      <button type="button" onClick={() => setRevision((r) => r + 1)}>
        Refresh Period Records
      </button>
      {!scope() || visible?.rows === null ? (
        <p role="alert">Period Records Are Unavailable.</p>
      ) : !visible ? (
        <p role="status">Loading Period Records…</p>
      ) : visible.rows.length === 0 ? (
        <p>No Recorded Periods Were Found For This Union.</p>
      ) : (
        <ul>
          {visible.rows.map((row) => (
            <li key={row.id}>
              {new Date(row.startAt).toLocaleDateString(undefined, {
                timeZone: 'America/Los_Angeles',
              })}{' '}
              to{' '}
              {new Date(row.endAt).toLocaleDateString(undefined, {
                timeZone: 'America/Los_Angeles',
              })}
              : {row.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One scoped browser workspace; refresh never closes a book or transfers chips. */
export default function WeeklyAccountingWorkspace({
  scopeKind,
  scopeRef,
}: {
  scopeKind: AccountingScopeKind;
  scopeRef: string;
}) {
  const { user, isHydrating } = useAuthUser();
  const guard = useCashoutScope(
    user?.id,
    JSON.stringify(['weekly-accounting', scopeKind, scopeRef])
  );
  const [resolved, setResolved] = useState<{ guard: () => boolean; id: string | null } | null>(
    null
  );
  const [ending, setEnding] = useState(() => accountingWeekEndDate(latestClosedAccountingWeek()));
  useEffect(() => {
    let active = true;
    setResolved(null);
    if (!user?.id || isHydrating || !guard())
      return () => {
        active = false;
      };
    const resolve = scopeKind === 'club' ? resolveClubUUID : resolveUnionUUID;
    void resolve(scopeRef)
      .then((id) => {
        if (active && guard())
          setResolved({ guard, id: isAccountingUUID(id) ? id.toLowerCase() : null });
      })
      .catch(() => {
        if (active && guard()) setResolved({ guard, id: null });
      });
    return () => {
      active = false;
    };
  }, [scopeKind, scopeRef, user?.id, isHydrating, guard]);
  const id = guard() && resolved?.guard === guard ? resolved.id : null;
  let week: AccountingWeek | null = null;
  try {
    week = accountingWeekEndingOn(ending);
  } catch {
    /* Keep the selected invalid week visibly unavailable. */
  }
  if (!user?.id || isHydrating || !guard())
    return <p role="alert">Accounting Is Unavailable Until This Account Is Ready.</p>;
  if (!id)
    return (
      <p role={resolved?.guard === guard ? 'alert' : 'status'}>
        {resolved?.guard === guard
          ? 'This Accounting Scope Is Unavailable.'
          : 'Loading Accounting Scope…'}
      </p>
    );
  return (
    <div>
      <h2>{scopeKind === 'club' ? 'Club' : 'Union'} Weekly Accounting</h2>
      <p>Weekly Accounting Runs Automatically. Select A Week To Read Its Recorded Status.</p>
      <label>
        Week Ending Monday{' '}
        <input
          aria-label="Week Ending Monday"
          type="date"
          value={ending}
          onChange={(e) => setEnding(e.target.value)}
        />
      </label>
      {week ? (
        <AccountingRunStatus
          key={`${id}:${user.id}:${ending}`}
          scopeKind={scopeKind}
          scopeId={id}
          {...week}
        />
      ) : (
        <p role="alert">Choose A Valid Monday For The Accounting Week.</p>
      )}
      {scopeKind === 'club' ? (
        <ClubWeeklyAccountingSummary key={`${id}:${user.id}`} clubId={id} />
      ) : (
        <UnionPeriodRecords key={`${id}:${user.id}`} unionId={id} actorId={user.id} />
      )}
      <p>
        <Link
          to={
            scopeKind === 'club'
              ? `/clubs/${encodeURIComponent(scopeRef)}/cashier`
              : `/unions/${encodeURIComponent(scopeRef)}/statements`
          }
        >
          {scopeKind === 'club' ? 'Open Club Cashier And Records' : 'Open Union Weekly Statements'}
        </Link>
      </p>
      <p>Invoices And Individual Receipts Remain In Messenger’s Club Arena Accounting Area.</p>
    </div>
  );
}
