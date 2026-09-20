import { useParams, useNavigate } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import WeeklyAccountingWorkspace from '../components/accounting/WeeklyAccountingWorkspace';
import styles from './SettlementPage.module.css';

/** Route-scoped automatic accounting. No browser open, close or payout controls. */
export default function SettlementPage() {
  const { clubId, unionId } = useParams<{ clubId: string; unionId: string }>();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const kind = clubId && !unionId ? 'club' : unionId && !clubId ? 'union' : null;
  const reference = kind === 'club' ? clubId : unionId;
  return (
    <main className={styles.page}>
      <button type="button" className={styles.backButton} onClick={() => navigate(-1)}>
        Back
      </button>
      <h1>Weekly Accounting</h1>
      {kind && reference ? (
        <WeeklyAccountingWorkspace
          key={`${kind}:${reference}:${user?.id ?? ''}`}
          scopeKind={kind}
          scopeRef={reference}
        />
      ) : (
        <p role="alert">Choose A Club Or Union To View Its Weekly Accounting.</p>
      )}
    </main>
  );
}
