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
    { id: '1', category: 'General', question: 'How do I create a club?', answer: 'Go to the main lobby and click "Create Club". Follow the setup wizard.' },
    { id: '2', category: 'Game', question: 'What is Rake?', answer: 'Rake is a small fee taken by the club from each pot to cover operational costs.' },
    { id: '3', category: 'Game', question: 'How does Bad Beat Jackpot work?', answer: 'If you lose with Quad 8s or better, you trigger the jackpot!' },
    { id: '4', category: 'Chips', question: 'How do I get more chips?', answer: 'Contact your club agent or admin to purchase more chips.' },
];

export function FAQPanel({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
    const [search, setSearch] = useState('');
    const [expandedId, setExpandedId] = useState<string | null>(null);

    if (!isOpen) return null;

    const filtered = DEFAULT_FAQS.filter(f =>
        f.question.toLowerCase().includes(search.toLowerCase()) ||
        f.answer.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="faq-overlay" onClick={onClose}>
            <div className="faq-modal" onClick={(e) => e.stopPropagation()}>
                <div className="faq-header">
                    <h2>Help & Rules</h2>
                    <button onClick={onClose}>×</button>
                </div>

                <div className="faq-search">
                    <span className="search-icon">🔍</span>
                    <input
                        placeholder="Search for answers..."
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
                                {expandedId === item.id && (
                                    <div className="faq-answer">
                                        {item.answer}
                                    </div>
                                )}
                            </div>
                        ))
                    ) : (
                        <div className="faq-empty">No results found for "{search}"</div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default FAQPanel;
