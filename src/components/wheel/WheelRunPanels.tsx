import type { WheelBonusAward, WheelCardAward } from '../../services/DiamondWheelService';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { diamondGameTitle } from '../../utils/diamondGameTitles';
import type { WheelRunPrize } from '../../utils/autoRun';
import { compactChips } from '../../utils/format';
import { WheelPrizeArt } from './WheelPrizeArt';
import revealStyles from './WheelWinReveal.module.css';
import styles from './WheelRunPanels.module.css';

/**
 * THE PANELS A RUN CAN LEAVE BEHIND (owner ruling 2026-09-21, R1, R15, R18).
 *
 * None of them does anything on a clock. A won game sits in the queue card
 * until Play Game is tapped; an unpicked Diamonds award sits in its own queue
 * card until Pick A Card is tapped; an open run sits behind Resume Run and End
 * Run until one is tapped; a finished run's summary lists what it won and
 * offers the first unfinished thing on the same plates. The awards they show
 * are the server's (`pending_awards`, `pending_cards`), so every one of them
 * survives a refresh.
 */

export function awardTitle(award: WheelBonusAward): string {
  return diamondGameTitle(award.game, award.boost_multiplier);
}

function awardCopy(award: WheelBonusAward): string {
  return `${awardTitle(award)}, ${award.entry_diamonds.toLocaleString()} Diamond Entry`;
}

/** One unpicked Diamonds award, as every panel names it (R15). */
export function cardAwardCopy(award: WheelCardAward): string {
  return `Diamond Cards, ${compactChips(award.risk_diamonds)} Diamonds Risked`;
}

/**
 * A visible, persistent card: the Diamonds picks won and not yet made, oldest
 * first (owner ruling 2026-09-21, R15). It sits beside the bonus-game queue
 * and behaves the same way - the award is the server's, so it survives a
 * refresh, and nothing opens it but the plate.
 */
export function WheelCardQueue({
  awards,
  disabled = false,
  onPick,
}: {
  awards: WheelCardAward[];
  disabled?: boolean;
  onPick: (award: WheelCardAward) => void;
}) {
  const next = awards[0];
  if (!next) return null;
  return (
    <section className={styles.card} aria-labelledby="wheel-card-queue-title">
      <h2 id="wheel-card-queue-title" className={styles.cardTitle}>
        {awards.length === 1
          ? 'You Have A Diamond Card Pick Waiting'
          : `You Have ${awards.length} Diamond Card Picks Waiting`}
      </h2>
      <p className={styles.cardCopy}>{cardAwardCopy(next)}</p>
      <p className={styles.cardMeta}>
        {awards.length > 1
          ? `Then ${awards.length - 1} More. One Card Pays Half, One Pays 2x, One Pays 3x.`
          : 'One Card Pays Half, One Pays 2x, One Pays 3x.'}
      </p>
      <button
        type="button"
        className={styles.cardButton}
        disabled={disabled}
        onClick={() => onPick(next)}
      >
        Pick A Card
      </button>
    </section>
  );
}

/** A visible, persistent card: the bonus games won and not yet played, oldest first. */
export function WheelBonusQueue({
  awards,
  disabled = false,
  onPlay,
}: {
  awards: WheelBonusAward[];
  disabled?: boolean;
  onPlay: (award: WheelBonusAward) => void;
}) {
  const next = awards[0];
  if (!next) return null;
  return (
    <section className={styles.card} aria-labelledby="wheel-bonus-queue-title">
      <h2 id="wheel-bonus-queue-title" className={styles.cardTitle}>
        {awards.length === 1
          ? 'You Have A Bonus Game To Play'
          : `You Have ${awards.length} Bonus Games To Play`}
      </h2>
      <p className={styles.cardCopy}>{awardCopy(next)}</p>
      {awards.length > 1 && (
        <p className={styles.cardMeta}>
          Then {awards.length - 1} More. Each One Opens When You Tap Play Game.
        </p>
      )}
      <button
        type="button"
        className={styles.cardButton}
        disabled={disabled}
        onClick={() => onPlay(next)}
      >
        Play Game
      </button>
    </section>
  );
}

/** An open run found on load: the player decides, the page never resumes by itself. */
export function WheelRunResume({
  spins,
  spinsDone,
  busy,
  onResume,
  onEnd,
}: {
  spins: number;
  spinsDone: number;
  busy: boolean;
  onResume: () => void;
  onEnd: () => void;
}) {
  const left = Math.max(0, spins - spinsDone);
  return (
    <section className={styles.card} aria-labelledby="wheel-run-resume-title">
      <h2 id="wheel-run-resume-title" className={styles.cardTitle}>
        Your Run Is Waiting
      </h2>
      <p className={styles.cardCopy}>
        {spinsDone.toLocaleString()} Of {spins.toLocaleString()} Spins Done. Resume To Spin The
        Rest, Or End The Run And Keep What It Won.
      </p>
      <div className={styles.cardActions}>
        <button type="button" className={styles.cardButtonQuiet} disabled={busy} onClick={onEnd}>
          End Run
        </button>
        <button
          type="button"
          className={styles.cardButton}
          disabled={busy || left === 0}
          onClick={onResume}
        >
          {left === 0 ? 'Run Complete' : `Resume Run (${left.toLocaleString()} Left)`}
        </button>
      </div>
    </section>
  );
}

export interface WheelRunSummaryData {
  total: number;
  done: number;
  /** Why the run ended early, or null when it ran to its end. */
  why: string | null;
  prizes: WheelRunPrize[];
  games: WheelBonusAward[];
  /** The Diamonds card picks the run won and has not made yet (R15). */
  cards: WheelCardAward[];
}

function prizeWorth(prize: WheelRunPrize): string {
  const v = prize.valueChips;
  return `$${Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)}`;
}

/**
 * One screen at the end of a run: every prize, every game, every card pick,
 * and one plate that opens the next unfinished thing.
 *
 * THE CARD PICKS COME FIRST (owner ruling 2026-09-21, R15). A pick is a tap
 * and a flip on this same page, and the diamonds it risked are not paid until
 * it is made; a bonus game is a whole round on another page. So the plate
 * offers the picks while the player is still here, and turns into Play Game
 * when the last card is turned over.
 */
export function WheelRunSummary({
  summary,
  onPlay,
  onPickCard,
  onClose,
}: {
  summary: WheelRunSummaryData;
  onPlay: (award: WheelBonusAward) => void;
  onPickCard: (award: WheelCardAward) => void;
  onClose: () => void;
}) {
  const nextCard = summary.cards[0];
  const next = summary.games[0];
  const title = summary.why ? 'Run Stopped' : 'Run Complete';
  const chips = summary.prizes
    .filter((p) => p.kind === 'chips')
    .reduce((sum, p) => sum + p.valueChips, 0);
  return (
    <Modal
      isOpen
      ariaLabel={title}
      onClose={onClose}
      closeOnOverlay={false}
      closeOnEscape
      showCloseButton={false}
      className={revealStyles.dialog}
    >
      <SpadeConsole
        eyebrow="Auto Spin"
        title={title}
        pill={`${summary.done.toLocaleString()} Of ${summary.total.toLocaleString()}`}
        plates={{
          secondary: { label: nextCard || next ? 'Not Now' : 'Close', onClick: onClose },
          primary: nextCard
            ? { label: 'Pick A Card', ink: 'gold', onClick: () => onPickCard(nextCard) }
            : next
              ? { label: 'Play Game', ink: 'gold', onClick: () => onPlay(next) }
              : { label: 'Continue', ink: 'white', onClick: onClose },
        }}
      >
        {summary.why && (
          <p className="sc-copy sc-copy--center sc-ink--gold" role="status">
            {summary.why}
          </p>
        )}
        <div className={styles.summary}>
          <h3 className={styles.summaryHeading}>
            {summary.prizes.length === 0
              ? 'No Instant Prizes This Run'
              : `Instant Prizes${chips > 0 ? `: ${chips.toLocaleString(undefined, { maximumFractionDigits: 2 })} Chips Paid` : ''}`}
          </h3>
          {summary.prizes.length > 0 && (
            <ul className={styles.list} aria-label="Prizes Won This Run">
              {summary.prizes.map((prize) => (
                <li key={prize.spinId} className={styles.item}>
                  <WheelPrizeArt segment={{ kind: prize.kind }} className={styles.itemArt} />
                  <span className={styles.itemTitle}>
                    {prize.upgraded ? `Upgrade: ${prize.title}` : prize.title}
                  </span>
                  <span className={styles.itemValue}>{prizeWorth(prize)}</span>
                </li>
              ))}
            </ul>
          )}
          {summary.cards.length > 0 && (
            <>
              <h3 className={styles.summaryHeading}>
                {`${summary.cards.length} Diamond Card ${summary.cards.length === 1 ? 'Pick' : 'Picks'} To Make`}
              </h3>
              <ul className={styles.list} aria-label="Diamond Card Picks Won This Run">
                {summary.cards.map((award, i) => (
                  <li key={award.id} className={styles.item} data-next={i === 0 || undefined}>
                    <WheelPrizeArt segment={{ kind: 'diamonds' }} className={styles.itemArt} />
                    <span className={styles.itemTitle}>{cardAwardCopy(award)}</span>
                    <span className={styles.itemValue}>{i === 0 ? 'Next' : `${i + 1}`}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className={styles.summaryHeading}>
            {summary.games.length === 0
              ? 'No Bonus Games This Run'
              : `${summary.games.length} Bonus ${summary.games.length === 1 ? 'Game' : 'Games'} To Play`}
          </h3>
          {summary.games.length > 0 && (
            <ul className={styles.list} aria-label="Bonus Games Won This Run">
              {summary.games.map((award, i) => (
                <li key={award.id} className={styles.item} data-next={i === 0 || undefined}>
                  <WheelPrizeArt
                    segment={{ kind: 'bonus', game: award.game }}
                    className={styles.itemArt}
                  />
                  <span className={styles.itemTitle}>{awardCopy(award)}</span>
                  <span className={styles.itemValue}>{i === 0 ? 'Next' : `${i + 1}`}</span>
                </li>
              ))}
            </ul>
          )}
          {nextCard ? (
            <p className="sc-copy sc-copy--center">
              Pick A Card Turns Over Your Diamond Cards. Your Bonus Games Wait Here Until Each Is
              Played.
            </p>
          ) : next ? (
            <p className="sc-copy sc-copy--center">
              Play Game Opens {awardTitle(next)}. The Rest Wait Here Until Each Is Played.
            </p>
          ) : null}
        </div>
      </SpadeConsole>
    </Modal>
  );
}
