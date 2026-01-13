/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💎 CURRENCY STORE — Purchase Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Mock store for purchasing diamonds or chips.
 * - Tabbed view (Diamonds / Gold)
 * - Pricing cards
 * - Mock payment flow
 */

import React, { useState } from 'react';
import './CurrencyStore.css';

export interface ProductItem {
    id: string;
    name: string;
    amount: number;
    bonus?: number;
    price: number;
    currencySymbol: string;
    imageUrl?: string;
    tag?: 'Best Value' | 'Popular';
}

export interface CurrencyStoreProps {
    isOpen: boolean;
    onClose: () => void;
    onPurchase: (product: ProductItem) => void;
}

const DIAMOND_PRODUCTS: ProductItem[] = [
    { id: 'd1', name: 'Starter Pack', amount: 100, price: 0.99, currencySymbol: '$' },
    { id: 'd2', name: 'Grinder Pack', amount: 550, bonus: 50, price: 4.99, currencySymbol: '$', tag: 'Popular' },
    { id: 'd3', name: 'High Roller', amount: 1200, bonus: 200, price: 9.99, currencySymbol: '$', tag: 'Best Value' },
    { id: 'd4', name: 'Whale Bundle', amount: 6500, bonus: 1500, price: 49.99, currencySymbol: '$' },
];

export function CurrencyStore({ isOpen, onClose, onPurchase }: CurrencyStoreProps) {
    const [activeTab, setActiveTab] = useState<'diamonds' | 'gold'>('diamonds');

    if (!isOpen) return null;

    const handleBuy = (product: ProductItem) => {
        // Mock purchase flow
        if (confirm(`Purchase ${product.name} for ${product.currencySymbol}${product.price}?`)) {
            onPurchase(product);
        }
    };

    return (
        <div className="store-overlay" onClick={onClose}>
            <div className="store-modal" onClick={(e) => e.stopPropagation()}>
                <div className="store-header">
                    <div className="title-group">
                        <span className="store-icon">🛒</span>
                        <h2>Store</h2>
                    </div>
                    <button className="close-btn" onClick={onClose}>×</button>
                </div>

                <div className="store-tabs">
                    <button
                        className={`tab ${activeTab === 'diamonds' ? 'active' : ''}`}
                        onClick={() => setActiveTab('diamonds')}
                    >
                        💎 Diamonds
                    </button>
                    <button
                        className={`tab ${activeTab === 'gold' ? 'active' : ''}`}
                        onClick={() => setActiveTab('gold')}
                    >
                        🪙 Gold
                    </button>
                </div>

                <div className="store-content">
                    <div className="products-grid">
                        {activeTab === 'diamonds' ? (
                            DIAMOND_PRODUCTS.map(p => (
                                <div key={p.id} className={`product-card ${p.tag ? 'tagged' : ''}`}>
                                    {p.tag && <span className="product-tag">{p.tag}</span>}
                                    <div className="product-visual">💎</div>
                                    <h3 className="product-amount">{p.amount.toLocaleString()}</h3>
                                    {p.bonus && <span className="product-bonus">+{p.bonus} Bonus</span>}
                                    <button className="buy-btn" onClick={() => handleBuy(p)}>
                                        {p.currencySymbol}{p.price}
                                    </button>
                                </div>
                            ))
                        ) : (
                            <div className="empty-tab">
                                <h3>Gold Packs Coming Soon!</h3>
                                <p>Check back later for chip deals.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default CurrencyStore;
