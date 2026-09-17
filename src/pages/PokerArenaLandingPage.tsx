/**
 * Poker Arena public landing page.
 *
 * Until 2026-09-16 an anonymous visit to /hub/club-arena was a JavaScript
 * redirect to the World Hub login, and index.html said `noindex, nofollow`.
 * Google therefore had nothing to index for Poker Arena at all: a crawler
 * that rendered the page saw a login form, and one that did not was told to
 * go away.
 *
 * This page is what a signed-out visitor (and Googlebot) now gets at the
 * arena root: a real, static description of the product with its own title,
 * description, canonical and JSON-LD (see src/lib/seo.ts), and two ways in.
 * Signed-in players never see it; AuthGuard renders HomePage for them exactly
 * as before. Nothing here fetches, so it renders identically for a crawler
 * and a person.
 *
 * Copy is Title Case (repo rule, scripts/ci/check-title-case.mjs).
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import styles from './PokerArenaLandingPage.module.css';
import { signInUrl } from '../lib/signIn';
import { WEB_ORIGIN } from '../lib/appBase';

const SIGN_UP_URL = `${WEB_ORIGIN}/auth/signup?redirect=${encodeURIComponent('/hub/club-arena')}`;

const FEATURES = [
  {
    title: 'Private Poker Clubs',
    body: 'Create A Club, Set Your Own Stakes And Rules, Invite Your Players And Keep Every Game Inside Your Own Walls.',
  },
  {
    title: 'Real Time Cash Games',
    body: "Hold'em, Omaha, Short Deck And Pineapple At Tables That Deal In Real Time, With Straddles, Bomb Pots, Run It Twice And Insurance.",
  },
  {
    title: 'Tournaments',
    body: 'Schedule Multi Table Tournaments With Custom Blind Structures, Rebuys, Bounties And Automatic Payouts.',
  },
  {
    title: 'Hand Histories And Stats',
    body: 'Every Hand Is Recorded. Replay It, Share It And Study Player Statistics And Leaderboards Across Your Club.',
  },
  {
    title: 'Club Management',
    body: 'A Cashier, Chip Ledger, Agent System, Rake Settings, Reports And Settlement Tools Built For Club Owners.',
  },
  {
    title: 'Unions And Diamond Arena',
    body: 'Link Clubs Into Unions For Shared Player Pools, And Play Diamond Denominated Games Inside The Same Arena.',
  },
];

const STEPS = [
  {
    title: 'Create Your Free Account',
    body: 'One Smarter.Poker Account Opens Poker Arena And Every Other Feature On The Platform.',
  },
  {
    title: 'Create Or Join A Club',
    body: 'Start Your Own Club In Minutes Or Join One With An Invite Code From Its Owner.',
  },
  {
    title: 'Sit Down And Play',
    body: 'Open The Lobby, Pick A Table Or Tournament And Play From Your Browser Or The Mobile App.',
  },
];

export default function PokerArenaLandingPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Smarter.Poker</p>
        <h1>Poker Arena: Private Online Poker Clubs</h1>
        <p className={styles.lede}>
          Create Or Join A Private Poker Club, Play Real Time Cash Games And Tournaments With Your
          Own Players, And Run The Whole Club From One Dashboard.
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href={SIGN_UP_URL}>
            Create A Free Account
          </a>
          <a className={styles.secondary} href={signInUrl('/')}>
            Sign In
          </a>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="features-heading">
        <h2 id="features-heading">Everything A Poker Club Needs</h2>
        <ul className={styles.grid}>
          {FEATURES.map((feature) => (
            <li key={feature.title} className={styles.card}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="steps-heading">
        <h2 id="steps-heading">How Poker Arena Works</h2>
        <ol className={styles.steps}>
          {STEPS.map((step, index) => (
            <li key={step.title} className={styles.step}>
              <span className={styles.stepNumber} aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="trust-heading">
        <h2 id="trust-heading">Fair Play, In Writing</h2>
        <p className={styles.trustCopy}>
          Every Table Runs On A Server Side Shuffle With Collusion Detection And Anti Cheat
          Monitoring. The Rules Are Public: Read The Fair Gaming Standards, The Terms Of Service And
          The Privacy Policy Before You Sit Down.
        </p>
        <nav className={styles.links} aria-label="Poker Arena Resources">
          <Link to="/help">Help Center</Link>
          <Link to="/legal/fair-gaming">Fair Gaming</Link>
          <Link to="/legal/tos">Terms Of Service</Link>
          <Link to="/legal/privacy">Privacy Policy</Link>
          <Link to="/legal/promotions">Promotion Rules</Link>
          <a href={`${WEB_ORIGIN}/hub`}>Smarter.Poker World Hub</a>
        </nav>
      </section>

      <section className={styles.cta}>
        <h2>Ready To Deal?</h2>
        <div className={styles.actions}>
          <a className={styles.primary} href={SIGN_UP_URL}>
            Create A Free Account
          </a>
          <a className={styles.secondary} href={signInUrl('/')}>
            Sign In To Poker Arena
          </a>
        </div>
      </section>
    </main>
  );
}
