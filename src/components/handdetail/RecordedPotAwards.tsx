import type { ReplayModel } from '../../utils/handReplay';
import { moneyForHand, potShareLabels } from '../../utils/handFormat';
import './HandDetailView.css';

/** Money that was recorded even when no cards were shown. Never a reveal. */
export default function RecordedPotAwards({
  model,
  variant = 'detail',
}: {
  model: ReplayModel;
  variant?: 'summary' | 'detail';
}) {
  const awards = (model.recordedBoardAwards || []).filter(
    (award) =>
      !model.showdown.some(
        (row) =>
          row.userId === award.userId &&
          row.boardIndex === award.boardIndex &&
          row.low === award.low
      )
  );
  if (!awards.length) return null;
  const money = moneyForHand(model);
  // Summary is a flex child of the modal's scroll body. Use its own unframed
  // rows, rather than the rundown's overflow-hidden showdown container.
  if (variant === 'summary') {
    return (
      <section className="hdm-showdown" aria-label="Pot Awards">
        <header className="hdm-section-head">
          <span>Pot Awards</span>
        </header>
        {awards.map((award) => (
          <div className="hdm-sd" key={award.key}>
            <div className="hdm-sd__who">
              <span className="hdm-sd__name">{award.name}</span>
              <span className="hdm-sd__pos">{award.position}</span>
              <span className="hdm-sd__pot">{award.boardLabel}</span>
            </div>
            <div className="hdm-sd__right">
              <span className="hdm-sd__collected">Collected {money(award.amount)}</span>
              {potShareLabels(award.potSlices, model).map((label, index) => (
                <span className="hdm-sd__pot" key={index}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>
    );
  }
  return (
    <section className="hdv__showdown" aria-label="Pot Awards">
      <header className="hdv__section-head">Pot Awards</header>
      {awards.map((award) => (
        <div className="hdv__sd" key={award.key}>
          <div className="hdv__sd-who">
            <span className="hdv__name">{award.name}</span>
            <span>{award.position}</span>
          </div>
          <span className="hdv__sd-pot">{award.boardLabel}</span>
          <div className="hdv__sd-right">
            <span className="hdv__sd-net">Collected {money(award.amount)}</span>
            {potShareLabels(award.potSlices, model).map((label, index) => (
              <span className="hdv__sd-pot" key={index}>
                {label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
