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
import { getBBJMiniQualifyingInfo } from '../../config/bbjMini';
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
    /* PINEAPPLE IS A LIVE VARIANT AND HAD NO ROW HERE (2026-09-11).
       Before the rule was unified, `normalizeVariantKey('pineapple')` fell
       through to 'nlh' and this strip highlighted the HOLD'EM row - the wrong
       bar, but a row. Giving the client its real `pineapple` entry made the bar
       correct everywhere else and left this strip with nothing to highlight:
       `blockKeyFor` returned 'pineapple' and no block had that key. It cannot
       collapse onto PLO4 either - same Quad Kings bar, but PLO4's note states
       Omaha's exactly-two-cards rule, which Pineapple does not have. */
    key: 'pineapple',
    games: 'Pineapple',
    cards: [c('K', 's'), c('K', 'h'), c('K', 'c'), c('K', 'd'), c('2', 's')],
    note: 'Quad Kings Or Better Must Lose. Both Of The Player\u2019s Hole Cards Must Play.',
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
  /**
   * WHICH JACKPOT (Dan 2026-09-11: the Qualifying Hands page "NEEDS TO BE
   * UPDATED WITH NEW MINI BBJ INFO AND DATA"). `mini` draws the mini's bar per
   * variant from config/bbjMini - aces full or better in hold'em, any quads in
   * Omaha - with the same card strip, so both tiers are read the same way.
   */
  kind?: 'main' | 'mini';
}

/** The mini's blocks: same games, same order, the mini's own bar and cards. */
const MINI_BLOCKS: VariantBlock[] = BLOCKS.map((b) => {
  const info = getBBJMiniQualifyingInfo(b.key);
  if (!info.eligible) return { ...b, cards: [], note: '' };
  const holdem = info.rule === 'holdem_aces_full';
  const hiLo = b.key === 'plo8';
  /* A RANKED BAR STATES ITS OWN RANK (Dan, 2026-09-12). PLO5/FLO5 is Quad Tens
     and Pineapple is Quad Deuces, so neither can take the generic "any four of
     a kind" note below - one of them would be wrong. The sentence is built
     from the variant's own label so it cannot drift from the bar. */
  if (info.rule === 'ranked_quads') {
    return { ...b, cards: info.minLosingHandCards, note: info.shortLabel + '. ' + info.subLabel };
  }
  /* Pineapple's MAIN bar is Quad Kings, so `info.rule` is plo_quads and it
     takes the "not only Quad Kings" note below - which is exactly right for
     it. Nothing here assumes an Omaha table. */
  return {
    ...b,
    cards: info.minLosingHandCards,
    note: holdem
      ? 'Aces Full Or Better Must Lose To Quads Or Better. No Ace-In-The-Hole Rule And No Both-Cards-Must-Play Rule: The Mini Catches The Beats The Main Rule Refuses On A Technicality.'
      : hiLo
        ? 'Any Four Of A Kind Or Better Must Lose To Bigger Quads Or Better, Judged On The High Hand Only. The Low Hand Never Qualifies.'
        : 'Any Four Of A Kind Or Better Must Lose To Bigger Quads Or Better. Not Only Quad Kings: Every Quad Below The Main Bar Pays The Mini.',
  };
});

/** Collapse aliases onto the block that actually renders. */
function blockKeyFor(variantKey: string | null | undefined): string | null {
  if (!variantKey) return null;
  const raw = String(variantKey).toLowerCase().trim();
  if (raw === 'flh') return 'nlh';
  if (raw === 'plo') return 'plo4';
  if (raw === 'plo_hilo') return 'plo8';
  /* FLO8 is the same GAME as PLO8 - four cards, exactly-two, 8-or-better low;
     only the betting differs, and betting has nothing to do with which hand
     qualifies. It had no block and no alias, so an FLO8 table highlighted
     nothing. (`pineapple` is NOT aliased: it has its own block above, because
     its note is not PLO4's.) */
  if (raw === 'flo8') return 'plo8';
  /* Same reasoning for the other two fixed-limit Omaha names, added with their
     BBJ_QUALIFYING_HANDS keys on 2026-09-12. */
  if (raw === 'flo4') return 'plo4';
  if (raw === 'flo5') return 'plo5';
  return raw;
}

export function BBJQualifyingHands({
  highlightVariantKey = null,
  kind = 'main',
}: BBJQualifyingHandsProps) {
  const hl = blockKeyFor(highlightVariantKey);
  const blocks = kind === 'mini' ? MINI_BLOCKS : BLOCKS;

  return (
    <div className="bbj-qh">
      {kind === 'mini' ? (
        <p className="bbj-qh__intro">
          The Mini Jackpot Pays A Flat Amount For The Beats The Main Rule Turns Away. The Losing
          Player Must Hold At Least The Hand Below And The Winner Must Still Hold Quads Or Better.
          The Same Pot, Player And Board Conditions Apply As For The Main Jackpot; The
          Ace-In-The-Hole And Both-Cards-Must-Play Rules Do Not.
        </p>
      ) : (
        <p className="bbj-qh__intro">
          The Losing Player Must Hold At Least The Hand Below.
          {BBJ_RULES.requireBothHoleCards
            ? ' Both Players Must Use Two Cards From Their Own Hand.'
            : ''}
          {/* THE RULE, NOT THE ASPIRATION (2026-09-11). This branch printed
              "The Prize Is Divided Between Them" whenever the flag was true,
              and the flag was true while the engine paid a single holder. The
              engine evaluates every loser and pays the strongest qualifying
              hand, which is the one that took the worse beat; a player has to
              be able to read that and predict it. If the flag is ever turned
              on, the sentence follows it back. */}
          {BBJ_RULES.splitIfMultipleQualify
            ? ' If More Than One Player Loses With A Qualifying Hand, The Prize Is Divided Between Them.'
            : ' If More Than One Player Loses With A Qualifying Hand, The Strongest Losing Hand Takes It.'}
        </p>
      )}

      {blocks.map((b) => {
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
                The {kind === 'mini' ? 'Mini ' : ''}Bad Beat Jackpot Is Not Available For{' '}
                {config?.label || b.games}.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default BBJQualifyingHands;
