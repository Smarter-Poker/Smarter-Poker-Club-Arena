/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ QUALIFYING HANDS — the minimum losing hand, per game, as real cards
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The third tab of the jackpot popup. A player deciding whether to chase this
 * should not have to parse "AAAJJ" — they should see the cards.
 *
 * The RANK of every hand shown here comes from BBJ_QUALIFYING_HANDS, which is
 * synced to the server that actually detects hits, so a variant can never
 * advertise a rule the engine will not pay. The SUITS are illustrative only:
 * the stored rule is a rank pattern (AAAJJ), not a specific holding, so the
 * suits exist purely to draw a legal-looking hand. The one exception is the
 * PLO5 straight flush, where the suits ARE the rule and are therefore all
 * spades on purpose.
 *
 * Variants the server marks ineligible (PLO6, Short Deck) render as ineligible
 * rather than being hidden — a player who plays them deserves to know why the
 * banner is missing, not to wonder.
 */

import { BBJ_QUALIFYING_HANDS, BBJ_RULES } from '../../config/RakeConfig';
import CardImage from '../table/CardImage';
import type { Card as DeckCard } from '../table/CardImage';
import './BBJQualifyingHands.css';

interface VariantBlock {
  key: string;
  games: string;
  /** Illustrative cards for the minimum qualifying LOSING hand. */
  cards: DeckCard[];
  /** The condition in a sentence, under the cards. */
  note: string;
}

const c = (rank: DeckCard['rank'], suit: DeckCard['suit']): DeckCard => ({ rank, suit });

const BLOCKS: VariantBlock[] = [
  {
    key: 'nlh',
    games: "NLH / FLH",
    cards: [c('A', 's'), c('A', 'h'), c('A', 'c'), c('J', 's'), c('J', 'h')],
    note: 'Aces full of Jacks or better must lose to Quads or a Straight Flush. The player holding the full house must have at least one Ace among their dealt cards.',
  },
  {
    key: 'plo4',
    games: 'PLO4 / FLO4',
    cards: [c('K', 's'), c('K', 'h'), c('K', 'c'), c('K', 'd'), c('2', 's')],
    note: 'Quad Kings or better must lose. Exactly two cards from the hand must play, for both players.',
  },
  {
    key: 'plo8',
    games: 'PLO8 (Hi-Lo)',
    cards: [c('K', 's'), c('K', 'h'), c('K', 'c'), c('K', 'd'), c('2', 's')],
    note: 'Quad Kings or better must lose, judged on the high hand only. The low hand never qualifies.',
  },
  {
    key: 'plo5',
    games: 'PLO5 / FLO5',
    cards: [c('8', 's'), c('7', 's'), c('6', 's'), c('5', 's'), c('4', 's')],
    note: 'An 8-high Straight Flush or better must lose. Exactly two cards from the hand must play, for both players.',
  },
  {
    key: 'plo6',
    games: 'PLO6',
    cards: [],
    note: '',
  },
  {
    key: 'short_deck',
    games: 'Short Deck',
    cards: [],
    note: '',
  },
];

export interface BBJQualifyingHandsProps {
  /** Variant key or display name of the table in play — its block is marked. */
  highlightVariantKey?: string | null;
}

/** Collapse aliases onto the block that actually renders. */
function blockKeyFor(variantKey: string | null | undefined): string | null {
  if (!variantKey) return null;
  const raw = String(variantKey).toLowerCase().trim();
  if (raw === 'flh') return 'nlh';
  if (raw === 'plo') return 'plo4';
  if (raw === 'plo_hilo') return 'plo8';
  return raw;
}

export function BBJQualifyingHands({ highlightVariantKey = null }: BBJQualifyingHandsProps) {
  const hl = blockKeyFor(highlightVariantKey);

  return (
    <div className="bbj-qh">
      <p className="bbj-qh__intro">
        The losing player must hold at least the hand below.
        {BBJ_RULES.requireBothHoleCards
          ? ' Both players must use two cards from their own hand.'
          : ''}
        {BBJ_RULES.splitIfMultipleQualify
          ? ' If more than one player loses with a qualifying hand, the prize is divided between them.'
          : ''}
      </p>

      {BLOCKS.map((b) => {
        const config = BBJ_QUALIFYING_HANDS[b.key];
        const eligible = config?.eligible !== false && b.cards.length > 0;
        const isHere = hl === b.key;
        return (
          <section
            className={`bbj-qh__block${eligible ? '' : ' is-ineligible'}${isHere ? ' is-current' : ''}`}
            key={b.key}
          >
            <header className="bbj-qh__head">
              <span className="bbj-qh__games">{b.games}</span>
              {isHere && <span className="bbj-qh__here">YOUR GAME</span>}
            </header>

            {eligible ? (
              <>
                <span className="bbj-qh__label">Minimum Qualifying Hand</span>
                <div className="bbj-qh__cards">
                  {b.cards.map((card, i) => (
                    <CardImage key={`${b.key}-${i}`} card={card} size="md" />
                  ))}
                </div>
                <p className="bbj-qh__note">{b.note}</p>
              </>
            ) : (
              <p className="bbj-qh__note bbj-qh__note--off">
                The Bad Beat Jackpot is not available for {config?.label || b.games}.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default BBJQualifyingHands;
