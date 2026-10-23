import type { ReplayModel } from '../../utils/handReplay';
import { moneyForHand, potShareLabels } from '../../utils/handFormat';
import './HandDetailView.css';

/** Money that was recorded even when no cards were shown. Never a reveal. */
export default function RecordedPotAwards({ model }: { model: ReplayModel }) {
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
