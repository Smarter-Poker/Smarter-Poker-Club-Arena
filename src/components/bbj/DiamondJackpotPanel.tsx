import { getAvatarWithFallback } from '../../utils/avatarGenerator';
import { titleCase } from '../../utils/titleCase';
import type { DiamondJackpotSnapshot } from '../../lib/diamondJackpotFeed';
import { stamp } from '../../utils/handFormat';
import './BBJBasicPanel.css';
import './BBJRecentHits.css';
const diamonds = (amount: number) =>
  amount.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' Diamonds';
export function DiamondJackpotWinners({
  snapshot,
  unavailable = false,
  kind,
  onOpenHand,
}: {
  snapshot: DiamondJackpotSnapshot | null;
  unavailable?: boolean;
  kind: 'main' | 'mini';
  onOpenHand: (id: string) => void;
}) {
  if (!snapshot)
    return (
      <p className="bbj-modal__rule-text">
        {unavailable
          ? 'Could Not Read Diamond Jackpot Winners.'
          : 'Reading Diamond Jackpot Winners'}
      </p>
    );
  const hits = snapshot.hits.filter((h) => h.kind === kind).slice(0, 5);
  if (!hits.length)
    return (
      <p className="bbj-modal__rule-text">
        No {kind === 'mini' ? 'Mini ' : ''}Diamond Jackpot Has Been Paid Yet.
      </p>
    );
  return (
    <div className="bbj-hits">
      {hits.map((h) => (
        <div
          key={h.id}
          className="bbj-hits__row is-clickable"
          role="button"
          tabIndex={0}
          onClick={() => onOpenHand(h.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenHand(h.id);
            }
          }}
          aria-label={'Open Jackpot Hand ' + h.hand_number}
        >
          <img
            className="bbj-hits__avatar"
            alt=""
            aria-hidden="true"
            width={96}
            height={96}
            loading="lazy"
            src={getAvatarWithFallback(
              h.loser_avatar_url,
              h.receipt.loser.userId,
              titleCase(h.loser_name),
              96
            )}
          />
          <div className="bbj-hits__who">
            <span className="bbj-hits__name">{titleCase(h.loser_name)}</span>
            <span className="bbj-hits__id">{h.loser_player_number ?? ''}</span>
          </div>
          <div className="bbj-hits__hand">
            <span className="bbj-hits__handname">{titleCase(h.verdict.loser_hand)}</span>
            <span className="bbj-hits__beat-name">
              Lost To {titleCase(h.winner_name)}'s {titleCase(h.verdict.winner_hand)}
            </span>
          </div>
          <div className="bbj-hits__right">
            <span className="bbj-hits__amt">+ {diamonds(h.receipt.loser.share)}</span>
            <span className="bbj-hits__when">{stamp(h.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
export function DiamondJackpotBasic({
  snapshot,
  unavailable = false,
  kind,
  bigBlind,
}: {
  snapshot: DiamondJackpotSnapshot | null;
  unavailable?: boolean;
  kind: 'main' | 'mini';
  bigBlind: number;
}) {
  if (!snapshot)
    return (
      <p className="bbj-modal__rule-text">
        {unavailable
          ? 'Could Not Read Diamond Jackpot Settings.'
          : 'Reading Diamond Jackpot Settings'}
      </p>
    );
  return (
    <div className="bbj-basic">
      <p className="bbj-basic__rules">
        {snapshot.enabled
          ? 'Eligible Flops Fund The Diamond Jackpot.'
          : 'Diamond Jackpots Are Off.'}{' '}
        Both Hole Cards Must Play. Double Boards Do Not Qualify. The Main Jackpot Takes Priority
        Over The Mini.
      </p>
      <div className="bbj-basic__scroll">
        <table className="bbj-basic__table">
          <thead>
            <tr>
              <th>Big Blind</th>
              <th>Drop</th>
              <th>Pot Must Exceed</th>
              <th>{kind === 'main' ? 'Pool Paid' : 'Mini Paid'}</th>
              <th>Bad Beat / Winner / Table</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.stakes.map((s) => (
              <tr key={s.big_blind} className={bigBlind === s.big_blind ? 'is-current' : ''}>
                <td>
                  {s.big_blind.toLocaleString()}
                  {bigBlind === s.big_blind ? ' · Your Stakes' : ''}
                </td>
                <td>{s.drop.toLocaleString()}</td>
                <td>{s.min_pot.toLocaleString()}</td>
                <td>
                  {kind === 'main'
                    ? s.payout_percent + '%'
                    : s.mini_payable
                      ? s.mini_amount.toLocaleString()
                      : 'Paused'}
                </td>
                <td>
                  {s.loser_percent}% / {s.winner_percent}% / {s.table_percent}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {kind === 'mini' && (
        <p className="bbj-basic__note">
          The Mini Pays From The Backup Reserve And Keeps At Least{' '}
          {diamonds(snapshot.reserve_floor)} In That Reserve.
        </p>
      )}
      <p className="bbj-basic__note">
        Every Amount Is In Whole Diamonds. Awards Go To Your Diamond Wallet When The Hand Settles.
        The Published Split For Each Stake Is Shown Above. Other Dealt Players Share The Table
        Portion. Whole-Diamond Remainders Go To The Bad Beat.
      </p>
    </div>
  );
}
