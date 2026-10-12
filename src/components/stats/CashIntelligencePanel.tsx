import { SpadeConsole } from '../console/SpadeConsole';
import type { CashOpportunityCount, CashOpportunityStats } from '../../services/StatsFactsService';
import { binomialConfidence } from '../../pages/stats/binomialConfidence';
import { titleCase } from '../../utils/titleCase';
import './CashIntelligencePanel.css';

export type CashEvidenceMetric = keyof CashOpportunityStats['opportunities'];

interface Props {
  data: CashOpportunityStats | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenEvidence?: (metric: CashEvidenceMetric) => void;
}

const GROUPS: Array<{
  title: string;
  metrics: Array<[CashEvidenceMetric, string]>;
}> = [
  {
    title: 'Before The Flop',
    metrics: [
      ['three_bet', '3-Bet'],
      ['four_bet', '4-Bet'],
      ['steal', 'Steal'],
      ['squeeze', 'Squeeze'],
      ['blind_defense', 'Blind Defense'],
    ],
  },
  {
    title: 'After The Flop',
    metrics: [
      ['cbet_flop', 'Flop C-Bet'],
      ['barrel_turn', 'Turn Barrel'],
      ['barrel_river', 'River Barrel'],
      ['check_raise', 'Check-Raise'],
      ['donk', 'Donk Bet'],
      ['probe', 'Probe Bet'],
    ],
  },
];

function measuredRate(value: CashOpportunityCount): number | null {
  if (!Number.isFinite(value.opportunities) || value.opportunities <= 0) return null;
  return Math.min(1, Math.max(0, value.actions / value.opportunities));
}

function OpportunityRow({
  metric,
  label,
  value,
  onOpenEvidence,
}: {
  metric: CashEvidenceMetric;
  label: string;
  value: CashOpportunityCount;
  onOpenEvidence?: (metric: CashEvidenceMetric) => void;
}) {
  const rate = measuredRate(value);
  const confidence = rate === null ? null : binomialConfidence(rate, value.opportunities);
  return (
    <div className="cash-intel__decision">
      <div className="cash-intel__decision-name">
        <strong>{label}</strong>
        <span>{value.opportunities.toLocaleString()} Opportunities</span>
      </div>
      <div className="cash-intel__reading">
        <span
          className={
            rate === null ? 'cash-intel__rate cash-intel__rate--empty' : 'cash-intel__rate'
          }
        >
          {rate === null ? 'Not Yet Measured' : `${(rate * 100).toFixed(1)}%`}
        </span>
        <span className="cash-intel__confidence">
          {confidence
            ? `95% Range ${confidence.lowerPercent.toFixed(1)} To ${confidence.upperPercent.toFixed(1)}%`
            : 'No Decision Sample Yet'}
        </span>
      </div>
      {onOpenEvidence && (
        <button type="button" onClick={() => onOpenEvidence(metric)}>
          Open Hands
        </button>
      )}
    </div>
  );
}

export default function CashIntelligencePanel({
  data,
  loading,
  error,
  onRetry,
  onOpenEvidence,
}: Props) {
  const state = loading ? 'Loading' : error ? 'Unavailable' : data ? 'Exact Facts' : 'Not Measured';
  return (
    <SpadeConsole
      family="spade"
      crest="spade"
      eyebrow="Cash Decisions"
      title="Cash Intelligence"
      subtitle="Opportunity-Based Rates From Accepted Hands"
      pill={state}
      foot="foot"
      className="cash-intel-console"
      aria-label="Cash Intelligence"
    >
      <div className="cash-intel">
        {loading && (
          <p className="cash-intel__state" role="status">
            Reading Accepted Hand Facts.
          </p>
        )}
        {!loading && error && (
          <div className="cash-intel__state" role="alert">
            <p>Cash Decision Facts Could Not Be Loaded.</p>
            {onRetry && (
              <button type="button" onClick={onRetry}>
                Try Again
              </button>
            )}
          </div>
        )}
        {!loading && !error && !data && (
          <p className="cash-intel__state" role="status">
            No Accepted Hands Carry The New Opportunity Facts Yet.
          </p>
        )}
        {!loading && !error && data && (
          <>
            <div className="cash-intel__coverage" aria-label="Fact Coverage">
              <div>
                <span>Exact</span>
                <strong>{data.coverage.exact_hands.toLocaleString()}</strong>
              </div>
              <div className={data.coverage.unavailable_hands ? 'cash-intel__unavailable' : ''}>
                <span>Older / Unavailable</span>
                <strong>{data.coverage.unavailable_hands.toLocaleString()}</strong>
              </div>
              <div>
                <span>Average Effective Stack</span>
                <strong>
                  {data.context.average_effective_stack_bb == null
                    ? 'Unavailable'
                    : `${data.context.average_effective_stack_bb.toFixed(1)} BB`}
                </strong>
              </div>
              <div>
                <span>In Position</span>
                <strong>
                  {data.context.position_measured_hands > 0
                    ? `${((data.context.in_position_hands / data.context.position_measured_hands) * 100).toFixed(1)}%`
                    : 'Unavailable'}
                </strong>
              </div>
            </div>

            <div className="cash-intel__matrix">
              {GROUPS.map((group) => (
                <section
                  key={group.title}
                  aria-labelledby={`cash-intel-${group.title.replace(/ /g, '-').toLowerCase()}`}
                >
                  <h3 id={`cash-intel-${group.title.replace(/ /g, '-').toLowerCase()}`}>
                    {group.title}
                  </h3>
                  {group.metrics.map(([metric, label]) => (
                    <OpportunityRow
                      key={metric}
                      metric={metric}
                      label={label}
                      value={data.opportunities[metric]}
                      onOpenEvidence={onOpenEvidence}
                    />
                  ))}
                </section>
              ))}
            </div>

            <section className="cash-intel__streets" aria-labelledby="cash-intel-street-title">
              <h3 id="cash-intel-street-title">Action Pressure By Street</h3>
              <div>
                {(['preflop', 'flop', 'turn', 'river'] as const).map((street) => {
                  const actions = data.actions_by_street[street];
                  const total = actions.aggressive + actions.passive;
                  const width = total ? (actions.aggressive / total) * 100 : 0;
                  return (
                    <div className="cash-intel__street" key={street}>
                      <span>{titleCase(street)}</span>
                      <span className="cash-intel__track">
                        <i style={{ width: `${width}%` }} />
                      </span>
                      <strong>
                        {actions.aggressive} / {actions.passive}
                      </strong>
                    </div>
                  );
                })}
              </div>
              <p>Aggressive / Passive Accepted Actions. Older Unavailable Hands Are Excluded.</p>
            </section>
          </>
        )}
      </div>
    </SpadeConsole>
  );
}
