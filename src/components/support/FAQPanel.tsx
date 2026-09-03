/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ❓ FAQ PANEL — Help & Rules
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Searchable Frequently Asked Questions.
 * - Accordion style Q&A
 * - Search bar
 */

import React, { useState } from 'react';
import './FAQPanel.css';

export interface FAQItem {
  id: string;
  question: string;
  answer: string;
  category: string;
}

export const DEFAULT_FAQS: FAQItem[] = [
  {
    id: '1',
    category: 'General',
    question: 'How Do I Create A Club?',
    answer: 'Go To The Main Lobby And Click "Create Club". Follow The Setup Wizard.',
  },
  {
    id: '2',
    category: 'Game',
    question: 'What Is Rake?',
    answer: 'Rake Is A Small Fee Taken By The Club From Each Pot To Cover Operational Costs.',
  },
  {
    id: '3',
    category: 'Game',
    question: 'How Does Bad Beat Jackpot Work?',
    answer:
      'Lose A Monster Hand And Win Big! In Hold\u2019em, Aces Full Of Jacks Or Better Must Lose To Quads Or Better (Both Hole Cards Play). In Omaha Games, Quad Kings Or Better Must Lose. When It Hits, The Loser Gets 50% Of The Payout, The Winner 25%, And Everyone Else Dealt In Splits The Rest - Credited Straight To Your Table Stack.',
  },
  {
    id: '4',
    category: 'Chips',
    question: 'How Do I Get More Chips?',
    answer: 'Contact Your Club Agent Or Admin To Purchase More Chips.',
  },
];

export function FAQPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!isOpen) return null;

  const filtered = DEFAULT_FAQS.filter(
    (f) =>
      f.question.toLowerCase().includes(search.toLowerCase()) ||
      f.answer.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="faq-overlay" onClick={onClose}>
      <div className="faq-modal" onClick={(e) => e.stopPropagation()}>
        <div className="faq-header">
          <h2>Help & Rules</h2>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="faq-search">
          <span className="search-icon">⌕</span>
          <input
            placeholder="Search For Answers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="faq-content">
          {filtered.length > 0 ? (
            filtered.map((item) => (
              <div
                key={item.id}
                className={`faq-item ${expandedId === item.id ? 'open' : ''}`}
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <div className="faq-question">
                  <span>{item.question}</span>
                  <span className="faq-arrow">▼</span>
                </div>
                {expandedId === item.id && <div className="faq-answer">{item.answer}</div>}
              </div>
            ))
          ) : (
            <div className="faq-empty">No Results Found For "{search}"</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FAQPanel;
