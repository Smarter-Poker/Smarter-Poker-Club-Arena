import { useNavigate } from 'react-router-dom';
import { useCanOperateUnionNetwork } from '../hooks/useCanCreateUnion';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCashoutScope } from '../hooks/useCashoutScope';
import { useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import WeeklyAccountingWorkspace from '../components/accounting/WeeklyAccountingWorkspace';
import { SpadeConsole } from '../components/console/SpadeConsole';
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
    return (
      <main className={styles.page}>
        <SpadeConsole
          className={styles.console}
          family="spade"
          eyebrow="Club Arena"
          title="Weekly Accounting"
          titleAs="h1"
          pill="Unavailable"
          pillInk="red"
          foot="foot"
        >
          <p className={`${styles.state} sc-ink--red`} role="alert">
            Accounting Is Unavailable Until This Account Is Ready.
          </p>
        </SpadeConsole>
      </main>
    );
  const scopeClubId = scope.clubId;
  const ledgerTitle = scopeClubId ? 'Club Transaction Records' : 'Your Account Transactions';
  return (
    <main className={styles.page}>
      <SpadeConsole
        className={styles.console}
        family="spade"
        eyebrow="Club Arena"
        title="Weekly Accounting"
        titleAs="h1"
        subtitle="Verified Settlement Records"
        pill={scopeClubId ? 'Club' : 'Account'}
        pillInk="blue"
        foot="foot"
      >
        <button type="button" className={styles.backButton} onClick={() => navigate(-1)}>
          Back
        </button>
        {scopeClubId ? (
          <WeeklyAccountingWorkspace
            key={`${scopeClubId}:${user.id}`}
            scopeKind="club"
            scopeRef={scopeClubId}
          />
        ) : (
          <section className={styles.scopeChooser} aria-label="Choose Accounting Scope">
            <p>Choose A Club Or Union From Its Accounting Page To View A Specific Weekly Record.</p>
            <div className={styles.scopeActions}>
              <button type="button" onClick={() => navigate('/clubs')}>
                Open Clubs
              </button>
              {canOperateUnionNetwork && (
                <button type="button" onClick={() => navigate('/unions')}>
                  Open Unions
                </button>
              )}
            </div>
          </section>
        )}
      </SpadeConsole>

      <SpadeConsole
        className={styles.ledgerConsole}
        family="spade"
        crest="flat"
        eyebrow="Settlement Center"
        title={ledgerTitle}
        pill="Verified"
        pillInk="blue"
        foot="foot"
        aria-label={ledgerTitle}
      >
        {/* The console above is the one region named ledgerTitle. The list keeps
            its own default name; passing ledgerTitle here as well gave the page
            two regions called "Club Transaction Records" (financial-admin-deep). */}
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
      </SpadeConsole>
    </main>
  );
}
