/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CURRENCY STORE — Purchase Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Store for purchasing diamonds or chips.
 * - Tabbed view (Diamonds / Gold)
 * - Pricing cards
 * - Payment integration via onPurchase callback
 */

import React, { useState, useEffect, useRef } from 'react';
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
  type: 'diamond' | 'gold';
}

export interface CurrencyStoreProps {
  isOpen: boolean;
  onClose: () => void;
  onPurchase: (product: ProductItem) => void;
  diamondProducts?: ProductItem[];
  goldProducts?: ProductItem[];
}

// Default diamond products
const DEFAULT_DIAMOND_PRODUCTS: ProductItem[] = [
  {
    id: 'd1',
    name: 'Starter Pack',
    amount: 100,
    price: 0.99,
    currencySymbol: '◉',
    type: 'diamond',
  },
  {
    id: 'd2',
    name: 'Grinder Pack',
    amount: 550,
    bonus: 50,
    price: 4.99,
    currencySymbol: '◉',
    tag: 'Popular',
    type: 'diamond',
  },
  {
    id: 'd3',
    name: 'High Roller',
    amount: 1200,
    bonus: 200,
    price: 9.99,
    currencySymbol: '◉',
    tag: 'Best Value',
    type: 'diamond',
  },
  {
    id: 'd4',
    name: 'Whale Bundle',
    amount: 6500,
    bonus: 1500,
    price: 49.99,
    currencySymbol: '◉',
    type: 'diamond',
  },
];

// Default gold/chip products
const DEFAULT_GOLD_PRODUCTS: ProductItem[] = [
  { id: 'g1', name: 'Starter Stack', amount: 1000, price: 0.99, currencySymbol: '◉', type: 'gold' },
  {
    id: 'g2',
    name: 'Cash Game Kit',
    amount: 5500,
    bonus: 500,
    price: 4.99,
    currencySymbol: '◉',
    tag: 'Popular',
    type: 'gold',
  },
  {
    id: 'g3',
    name: 'Tournament Roll',
    amount: 12000,
    bonus: 2000,
    price: 9.99,
    currencySymbol: '◉',
    tag: 'Best Value',
    type: 'gold',
  },
  {
    id: 'g4',
    name: 'High Stakes Fund',
    amount: 65000,
    bonus: 15000,
    price: 49.99,
    currencySymbol: '◉',
    type: 'gold',
  },
];

export function CurrencyStore({
  isOpen,
  onClose,
  onPurchase,
  diamondProducts,
  goldProducts,
}: CurrencyStoreProps) {
  const [activeTab, setActiveTab] = useState<'diamonds' | 'gold'>('diamonds');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      const products =
        activeTab === 'diamonds'
          ? diamondProducts || DEFAULT_DIAMOND_PRODUCTS
          : goldProducts || DEFAULT_GOLD_PRODUCTS;
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = products.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    }
  }, [isOpen, activeTab, diamondProducts, goldProducts]);

  if (!isOpen) return null;

  const diamonds = diamondProducts || DEFAULT_DIAMOND_PRODUCTS;
  const gold = goldProducts || DEFAULT_GOLD_PRODUCTS;

  const handleBuy = (product: ProductItem) => {
    // Delegate to parent for actual payment processing
    onPurchase(product);
  };

  const renderProducts = (products: ProductItem[], icon: string) =>
    products.map((p: ProductItem, i: number) => (
      <div
        key={p.id}
        className={`product-card ${p.tag ? 'tagged' : ''}`}
        style={{
          opacity: visibleItems.has(i) ? 1 : 0,
          transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {p.tag && <span className="product-tag">{p.tag}</span>}
        <div className="product-visual">{icon}</div>
        <h3 className="product-amount">{p.amount.toLocaleString()}</h3>
        {p.bonus && <span className="product-bonus">+{p.bonus} Bonus</span>}
        <button className="buy-btn" onClick={() => handleBuy(p)}>
          {p.currencySymbol}
          {p.price}
        </button>
      </div>
    ));

  return (
    <div className="store-overlay" onClick={onClose}>
      <div className="store-modal" onClick={(e) => e.stopPropagation()}>
        <div className="store-header">
          <div className="title-group">
            <span className="store-icon"></span>
            <h2>Store</h2>
          </div>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="store-tabs">
          <button
            className={`tab ${activeTab === 'diamonds' ? 'active' : ''}`}
            onClick={() => setActiveTab('diamonds')}
          >
            Diamonds
          </button>
          <button
            className={`tab ${activeTab === 'gold' ? 'active' : ''}`}
            onClick={() => setActiveTab('gold')}
          >
            Gold
          </button>
        </div>

        <div className="store-content">
          <div className="products-grid">
            {activeTab === 'diamonds' ? renderProducts(diamonds, '') : renderProducts(gold, '')}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CurrencyStore;
