/**
 * ❓ HELP PAGE
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import FeedbackForm from '../components/support/FeedbackForm';
import SystemStatus from '../components/support/SystemStatus';
import './HelpPage.css';

const faqItemAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(6px)',
  animation: `fadeInUp 0.4s ease-out ${index * 50}ms forwards`,
});

interface FAQItem {
  question: string;
  answer: string;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    question: 'How do I join a club?',
    answer:
      'Go to the Clubs page, find a club you like, and tap "Join". Some clubs require an invitation code or approval from an admin.',
  },
  {
    question: 'How do I buy chips?',
    answer:
      'Use the Cashier to convert diamonds to chips. Go to your Wallet and tap "Mint Chips" to exchange diamonds at the current rate.',
  },
  {
    question: 'What is the rake structure?',
    answer:
      'Rake is 10% of the pot, up to a cap that depends on the stake - from $3 at the smallest blinds to $20 at the largest. The cap is a cash amount, not a number of big blinds, and it is reduced when a hand is played heads-up or three-handed. No flop, no drop: an uncontested pot is never raked. A small portion of the rake also funds the Bad Beat Jackpot.',
  },
  {
    question: 'How do settlements work?',
    answer:
      'Settlements happen weekly on Monday. Your net profit/loss is calculated, and rakeback is applied based on your agent hierarchy.',
  },
  {
    question: 'How do I become an agent?',
    answer:
      'Contact your club owner to be promoted to an agent role. Agents can recruit players and earn commissions on their rake.',
  },
  {
    question: 'What is the Bad Beat Jackpot?',
    answer:
      'The BBJ is a progressive jackpot for losing a monster hand. In Hold\u2019em, Aces full of Jacks or better must lose to Quads or better, and both of your hole cards must play. In Omaha games, Quad Kings or better must lose. When it hits, the losing hand takes 50%, the winning hand 25%, and everyone else dealt into the hand splits the remaining 25% \u2014 credited straight to your table stack.',
  },
  {
    question: 'How do I report a problem?',
    answer: 'Use the support chat below to contact our team, or email support@clubarena.poker',
  },
];

export default function HelpPage() {
  useEffect(() => {
    document.title = 'Help | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);

  const filteredFAQ = FAQ_ITEMS.filter(
    (item) =>
      item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.answer.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="help-page">
      <div className="help-search">
        <input
          type="text"
          placeholder="Search for help..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="faq-list">
        {filteredFAQ.map((item, index) => (
          <div
            key={index}
            style={faqItemAnimationStyle(index)}
            className={`faq-item ${expandedIndex === index ? 'expanded' : ''}`}
          >
            <button
              className="faq-question"
              onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
            >
              <span>{item.question}</span>
              <span className="faq-toggle">{expandedIndex === index ? '−' : '+'}</span>
            </button>
            {expandedIndex === index && <div className="faq-answer">{item.answer}</div>}
          </div>
        ))}

        {filteredFAQ.length === 0 && (
          <div className="empty-state">
            <p>No Results For "{searchQuery}"</p>
          </div>
        )}
      </div>

      <div className="help-footer">
        <h3>Still Need Help?</h3>
        <p>Our Support Team Is Available 24/7</p>
        <button className="btn btn-primary" onClick={() => setShowFeedbackForm(true)}>
          Contact Support
        </button>
      </div>

      {/* Feedback Form Modal */}
      <FeedbackForm isOpen={showFeedbackForm} onClose={() => setShowFeedbackForm(false)} />
    </div>
  );
}
