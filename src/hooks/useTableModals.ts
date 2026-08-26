import { useState, useCallback } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useTableModals Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Unified modal state management for the poker table interface.
 * Consolidates all modal visibility states into a single hook to:
 * - Reduce boilerplate state declarations
 * - Prevent multiple modals from being open simultaneously
 * - Improve maintainability and reduce re-renders
 * - Provide consistent modal opening/closing patterns
 */

export type ModalName =
  | 'buyIn'
  | 'cashier'
  | 'settings'
  | 'tableMenu'
  | 'handReplay'
  | 'rules'
  | 'playerNotes'
  | 'waitList'
  | 'sitOut'
  | 'insurance'
  | 'leaderboard'
  | 'shareHand'
  | 'throwableSelector'
  | 'handHistory'
  | 'rebuy'
  | 'addOn'
  | 'gtoAdvisor';

export interface UseTableModalsReturn {
  activeModal: ModalName | null;
  openModal: (name: ModalName) => void;
  closeModal: () => void;
  isOpen: (name: ModalName) => boolean;
}

/**
 * Hook to manage all modal visibility states in a single location
 * Only one modal can be open at a time (mutually exclusive pattern)
 */
export function useTableModals(): UseTableModalsReturn {
  const [activeModal, setActiveModal] = useState<ModalName | null>(null);

  const openModal = useCallback((name: ModalName) => {
    setActiveModal(name);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
  }, []);

  const isOpen = useCallback(
    (name: ModalName): boolean => {
      return activeModal === name;
    },
    [activeModal]
  );

  return { activeModal, openModal, closeModal, isOpen };
}
