/**
 * FINANCIAL HEALTH — staff-only directory for authoritative server controls.
 *
 * Browser-local timers are not platform health. Ledger reconciliation is
 * server-owned, and credit enforcement is authorized per club. This page
 * therefore exposes neither the retired client reconciliation no-op nor an
 * unscoped browser suspension scan.
 */
import { useNavigate } from 'react-router-dom';
import { SpadeConsole } from '../components/console/SpadeConsole';
import './FinancialHealthPage.css';

export default function FinancialHealthPage() {
  const navigate = useNavigate();

  return (
    <div className="financial-health-page">
      <SpadeConsole
        className="fhp__console"
        family="riveted"
        eyebrow="Financial Admin"
        title="Financial Health"
        titleId="financial-health-title"
        pill="Server Managed"
        pillInk="blue"
        plates={{
          secondary: { label: 'Admin Hub', onClick: () => navigate('/financial-admin') },
          primary: {
            label: 'Drift Incidents',
            ink: 'white',
            onClick: () => navigate('/financial-incidents'),
          },
        }}
      >
        <section className="fhp__section" aria-labelledby="fhp-system-status">
          <div className="fhp__section-head">
            <h2 id="fhp-system-status" className="fhp__section-title sc-label sc-ink--silver">
              System Status
            </h2>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Platform Health Source</span>
            <span className="fhp__row-value sc-ink--silver">Authoritative Server Reads</span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Browser Cron</span>
            <span className="fhp__row-value sc-ink--gold">Not A Health Certificate</span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Manual Global Mutations</span>
            <span className="fhp__row-value sc-ink--silver">Unavailable</span>
          </div>
        </section>

        <section className="fhp__section" aria-labelledby="fhp-ledger">
          <div className="fhp__section-head">
            <h2 id="fhp-ledger" className="fhp__section-title sc-label sc-ink--silver">
              Ledger Reconciliation
            </h2>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Execution</span>
            <span className="fhp__row-value sc-ink--silver">Server Scheduled</span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Status Here</span>
            <span className="fhp__row-value sc-ink--gold">Unavailable On This Page</span>
          </div>
          <p className="sc-copy fhp__state">
            Browser Reconciliation Is Retired Because A Client Cannot See Platform-Wide Supply. Use
            Drift Incidents For The Verified Burn-In Gate, Drift Queue And Balance-As-Of Readout.
          </p>
        </section>

        <section className="fhp__section" aria-labelledby="fhp-suspension">
          <div className="fhp__section-head">
            <h2 id="fhp-suspension" className="fhp__section-title sc-label sc-ink--silver">
              Credit Enforcement
            </h2>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Authority</span>
            <span className="fhp__row-value sc-ink--silver">Selected Club Only</span>
          </div>
          <div className="fhp__row">
            <span className="fhp__row-label sc-ink--blue">Global Browser Scan</span>
            <span className="fhp__row-value sc-ink--silver">Unavailable</span>
          </div>
          <p className="sc-copy fhp__state">
            This Page Does Not Run An Unscoped Credit Scan. Credit Changes Require Credit Admin For
            One Selected Club And Are Reauthorized By The Server.
          </p>
        </section>
      </SpadeConsole>
    </div>
  );
}
