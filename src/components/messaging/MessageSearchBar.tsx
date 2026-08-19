/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGE SEARCH BAR — In-Conversation Search
 * ═══════════════════════════════════════════════════════════════════════════════
 * Debounced search, result count, navigation between results
 */

import { useState, useCallback, useEffect } from 'react';
import { messagingService, type Message } from '../../services/MessagingService';
import { useDebounce } from '../../hooks/useDebounce';
import styles from './MessageSearchBar.module.css';

interface MessageSearchBarProps {
  conversationId: string;
  onResultSelect?: (messageId: string) => void;
  onClose: () => void;
}

export default function MessageSearchBar({
  conversationId,
  onResultSelect,
  onClose,
}: MessageSearchBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [searching, setSearching] = useState(false);

  const debouncedSearch = useDebounce(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setCurrentIndex(0);
      return;
    }
    setSearching(true);
    const found = await messagingService.searchMessages(conversationId, q);
    setResults(found);
    setCurrentIndex(0);
    if (found.length > 0 && onResultSelect) {
      onResultSelect(found[0].id);
    }
    setSearching(false);
  }, 400);

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value);
      debouncedSearch(value);
    },
    [debouncedSearch]
  );

  const goNext = () => {
    if (results.length === 0) return;
    const next = (currentIndex + 1) % results.length;
    setCurrentIndex(next);
    onResultSelect?.(results[next].id);
  };

  const goPrev = () => {
    if (results.length === 0) return;
    const prev = (currentIndex - 1 + results.length) % results.length;
    setCurrentIndex(prev);
    onResultSelect?.(results[prev].id);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && !e.shiftKey) goNext();
      if (e.key === 'Enter' && e.shiftKey) goPrev();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [results, currentIndex]);

  return (
    <div className={styles.container}>
      <div className={styles.searchWrapper}>
        <span className={styles.icon}>⌕</span>
        <input
          type="text"
          className={styles.input}
          placeholder="Search messages..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          autoFocus
        />
        {searching && <div className={styles.spinner} />}
        {results.length > 0 && (
          <span className={styles.count}>
            {currentIndex + 1}/{results.length}
          </span>
        )}
        {results.length > 1 && (
          <div className={styles.navButtons}>
            <button onClick={goPrev} className={styles.navBtn}>
              ▲
            </button>
            <button onClick={goNext} className={styles.navBtn}>
              ▼
            </button>
          </div>
        )}
        <button onClick={onClose} className={styles.closeBtn}>
          ✕
        </button>
      </div>
    </div>
  );
}
