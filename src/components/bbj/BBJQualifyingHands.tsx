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
    games: 'NLH / FLH',
    cards: [c('A', 's'), c('A', 'h'), c('A', 'c'), c('J', 's'), c('J', 'h')],
    note: 'Aces Full Of Jacks Or Better Must Lose To Quads Or A Straight Flush. The Player Holding The Full House Must Have At Least One Ace Among Their Dealt Cards.',
  },
  {
    key: 'plo4',
    games: 'PLO4 / FLO4',
    cards: [c('K', 's'), c('K', 'h'), c('K', 'c'), c('K', 'd'), c('2', 's')],
    note: 'Quad Kings Or Better Must Lose. Exactly Two Cards From The Hand Must Play, For Both Players.',
  },
  {
    key: 'plo8',
    games: 'PLO8 (Hi-Lo)',
    cards: [c('K', 's'), c('K', 'h'), c('K', 'c'), c('K', 'd'), c('2', 's')],
    note: 'Quad Kings Or Better Must Lose, Judged On The High Hand Only. The Low Hand Never Qualifies.',
  },
  {
    key: 'plo5',
    games: 'PLO5 / FLO5',
    cards: [c('8', 's'), c('7', 's'), c('6', 's'), c('5', 's'), c('4', 's')],
    note: 'An 8-High Straight Flush Or Better Must Lose. Exactly Two Cards From The Hand Must Play, For Both Players.',
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
        The Losing Player Must Hold At Least The Hand Below.
        {BBJ_RULES.requireBothHoleCards
          ? ' Both Players Must Use Two Cards From Their Own Hand.'
          : ''}
        {BBJ_RULES.splitIfMultipleQualify
          ? ' If More Than One Player Loses With A Qualifying Hand, The Prize Is Divided Between Them.'
          : ''}
      </p>

      {BLOCKS.map((b) => {
        const config = BBJ_QUALIFYING_HANDS[b.key];
        /**
         * ELIGIBILITY IS A RULE, NOT A RENDERING DETAIL.
         *
         * This read `config?.eligible !== false && b.cards.length > 0`, so an
         * empty `cards` array — a presentation choice — could veto the config.
         * The day PLO6 or short deck becomes eligible in RakeConfig, this panel
         * would go on telling players it is not, and the panel is the thing
         * players read the rules from. The config decides; the cards are drawn
         * if we have them to draw.
         */
        const eligible = config?.eligible !== false && !!config?.minLosingHand;
        const isHere = hl === b.key;
        return (
          <section
            className={`bbj-qh__block${eligible ? '' : ' is-ineligible'}${isHere ? ' is-current' : ''}`}
            key={b.key}
          >
            <header className="bbj-qh__head">
              <span className="bbj-qh__games">{b.games}</span>
              {isHere && <span className="bbj-qh__here">YOUR GAME</span>}
              {eligible && b.cards.length === 0 && (
                <span className="bbj-qh__minimum">{config?.minLosingHand}</span>
              )}
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
                The Bad Beat Jackpot Is Not Available For {config?.label || b.games}.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default BBJQualifyingHands;
