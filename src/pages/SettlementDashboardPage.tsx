import { useNavigate } from 'react-router-dom';
import { useCanOperateUnionNetwork } from '../hooks/useCanCreateUnion';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCashoutScope } from '../hooks/useCashoutScope';
import { useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import WeeklyAccountingWorkspace from '../components/accounting/WeeklyAccountingWorkspace';
import styles from './SettlementPage.module.css';

export default function SettlementDashboardPage() {
  const scope = useFinancialAdminScope();
  const { user, isHydrating } = useAuthUser();
  const navigate = useNavigate();
  const { canOperateUnionNetwork } = useCanOperateUnionNetwork();
  const current = useCashoutScope(
    user?.id,
    JSON.stringify(['settlement-dashboard', scope.clubId, scope.userId, scope.status])
  );
  if (scope.status !== 'ready') return <FinancialAdminScopeState scope={scope} />;
  if (!user?.id || isHydrating || scope.userId !== user.id || !current())
    return <p role="alert">Accounting Is Unavailable Until This Account Is Ready.</p>;
  const scopeClubId = scope.clubId;
  return (
    <main className={styles.page}>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <h1>Weekly Accounting</h1>
      {scopeClubId ? (
        <WeeklyAccountingWorkspace
          key={`${scopeClubId}:${user.id}`}
          scopeKind="club"
          scopeRef={scopeClubId}
        />
      ) : (
        <section>
          <p>Choose A Club Or Union From Its Accounting Page To View A Specific Weekly Record.</p>
          <button type="button" onClick={() => navigate('/clubs')}>
            Open Clubs
          </button>
          {canOperateUnionNetwork && (
            <button type="button" onClick={() => navigate('/unions')}>
              Open Unions
            </button>
          )}
        </section>
      )}
      <section aria-label="Transaction Records">
        <h2>Transaction Records</h2>
        {scopeClubId ? (
          <TransactionLedgerView
            clubId={scopeClubId}
            clubScoped
            key={`${scopeClubId}:${user.id}`}
            limit={25}
          />
        ) : (
          <TransactionLedgerView key={user.id} userId={user.id} limit={25} />
        )}
      </section>
    </main>
  );
}
