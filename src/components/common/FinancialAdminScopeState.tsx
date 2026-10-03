/**
 * What an admin money page renders while its club scope is not `ready`.
 *
 * One component so the five global-path money pages agree on the three
 * non-ready answers: loading (wait, render nothing financial), denied (the
 * viewer holds no finance role anywhere, or not in the club they named) and
 * error (the club could not be found or the membership could not be read).
 * A page that has not been handed a club renders THIS, never a table of
 * somebody's numbers with an empty filter.
 */
import { useNavigate } from 'react-router-dom';
import type { FinancialAdminScope } from '../../hooks/useFinancialAdminScope';
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './FinancialAdminScopeState.module.css';

export default function FinancialAdminScopeState({ scope }: { scope: FinancialAdminScope }) {
  const navigate = useNavigate();
  const denied = scope.status === 'denied';
  const failed = scope.status === 'error';
  const message = denied
    ? scope.message || 'Your Role Does Not Include Finance Access.'
    : failed
      ? scope.message || 'Your Club Access Could Not Be Verified.'
      : 'Checking Your Club Finance Access.';

  return (
    <main className={styles.page}>
      <SpadeConsole
        family={failed ? 'riveted' : 'shark'}
        crest={denied ? 'flat' : 'spade'}
        eyebrow="Club Arena Data"
        title={denied ? 'Financial Access Restricted' : 'Financial Access'}
        subtitle={message}
        pill={denied ? 'Restricted' : failed ? 'Unavailable' : 'Checking'}
        pillInk={denied || failed ? 'red' : 'blue'}
        foot={failed || denied ? 'plates' : 'foot'}
        plates={
          failed
            ? {
                secondary: { label: 'Back', onClick: () => navigate(-1) },
                primary: { label: 'Retry', onClick: scope.reload },
              }
            : denied
              ? { primary: { label: 'Back', onClick: () => navigate(-1) } }
              : undefined
        }
      >
        <p className="sc-copy sc-copy--center" role={denied || failed ? 'alert' : 'status'}>
          {message}
        </p>
      </SpadeConsole>
    </main>
  );
}
