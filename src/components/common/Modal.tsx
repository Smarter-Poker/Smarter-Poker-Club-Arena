/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🪟 MODAL — Dialog & Modal Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { IconButton } from './Button';
import './Modal.css';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  size?: 'small' | 'medium' | 'large' | 'fullscreen';
  closeOnOverlay?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  className?: string;
  /**
   * An accessible name for a dialog that renders no `title` header.
   * A full-screen panel that draws its own heading and its own close control
   * still has to announce itself to a screen reader, and `aria-labelledby`
   * only points at the header this modal did not render. Optional and
   * additive: a modal with a `title` is named by it exactly as before.
   */
  ariaLabel?: string;
}

const overlayVariants = {
  hidden: { opacity: 0, backdropFilter: 'blur(0px)' },
  visible: {
    opacity: 1,
    backdropFilter: 'blur(4px)',
    transition: { duration: 0.25, ease: 'easeInOut' },
  },
  exit: { opacity: 0, backdropFilter: 'blur(0px)', transition: { duration: 0.2 } },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.92, y: 30 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      damping: 28,
      stiffness: 350,
      mass: 1.2,
      velocity: 2,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    y: 20,
    transition: { type: 'spring', damping: 30, stiffness: 300, duration: 0.2 },
  },
};

/**
 * Main modal component
 */
export function Modal({
  isOpen,
  onClose,
  children,
  title,
  size = 'medium',
  closeOnOverlay = true,
  closeOnEscape = true,
  showCloseButton = true,
  className = '',
  ariaLabel,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Handle escape key
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        onClose();
      }
    },
    [onClose, closeOnEscape]
  );

  // Focus trap: handle Tab key to cycle focus within modal
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !modalRef.current) return;

    const focusableElements = modalRef.current.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      // Store the previously focused element
      previousActiveElement.current = document.activeElement as HTMLElement;

      document.addEventListener('keydown', handleEscape);
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';

      // Focus the first focusable element in the modal
      setTimeout(() => {
        if (modalRef.current) {
          const focusable = modalRef.current.querySelector(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          ) as HTMLElement;
          focusable?.focus();
        }
      }, 0);
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';

      // Return focus to the element that triggered the modal
      if (!isOpen && previousActiveElement.current) {
        previousActiveElement.current.focus();
      }
    };
  }, [isOpen, handleEscape, handleKeyDown]);

  const content = (
    <AnimatePresence>
      {isOpen && (
        <div className="modal-portal">
          <motion.div
            className="modal-overlay"
            variants={overlayVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onClick={closeOnOverlay ? onClose : undefined}
          />
          <motion.div
            ref={modalRef}
            className={`modal modal-${size} ${className}`}
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'modal-title' : undefined}
            aria-label={!title && ariaLabel ? ariaLabel : undefined}
          >
            {(title || showCloseButton) && (
              <div className="modal-header">
                {title && (
                  <h2 id="modal-title" className="modal-title">
                    {title}
                  </h2>
                )}
                {showCloseButton && (
                  <IconButton
                    icon="✕"
                    label="Close Dialog"
                    variant="ghost"
                    size="small"
                    onClick={onClose}
                    className="modal-close"
                  />
                )}
              </div>
            )}
            <div className="modal-content">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(content, document.body);
}

/**
 * Modal footer for actions
 */
export function ModalFooter({
  children,
  align = 'right',
}: {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right' | 'space-between';
}) {
  return <div className={`modal-footer modal-footer-${align}`}>{children}</div>;
}

/**
 * Alert dialog for confirmations
 */
export function AlertDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger' | 'warning';
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="small" title={title}>
      <div className="alert-dialog-content">
        <p className="alert-dialog-message">{message}</p>
      </div>
      <ModalFooter align="right">
        <button className="btn btn-secondary btn-medium" onClick={onClose}>
          {cancelText}
        </button>
        <button
          className={`btn btn-${variant === 'danger' ? 'danger' : variant === 'warning' ? 'warning' : 'primary'} btn-medium`}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmText}
        </button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * Drawer/slide-in panel
 */
export function Drawer({
  isOpen,
  onClose,
  children,
  title,
  position = 'right',
  size = 'medium',
  showCloseButton = true,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  position?: 'left' | 'right' | 'top' | 'bottom';
  size?: 'small' | 'medium' | 'large';
  showCloseButton?: boolean;
}) {
  const drawerVariants = {
    hidden: {
      x: position === 'right' ? '100%' : position === 'left' ? '-100%' : 0,
      y: position === 'bottom' ? '100%' : position === 'top' ? '-100%' : 0,
    },
    visible: { x: 0, y: 0 },
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const content = (
    <AnimatePresence>
      {isOpen && (
        <div className="drawer-portal">
          <motion.div
            className="drawer-overlay"
            variants={overlayVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onClick={onClose}
          />
          <motion.div
            className={`drawer drawer-${position} drawer-${size}`}
            variants={drawerVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            {(title || showCloseButton) && (
              <div className="drawer-header">
                {title && <h2 className="drawer-title">{title}</h2>}
                {showCloseButton && (
                  <IconButton
                    icon="✕"
                    label="Close"
                    variant="ghost"
                    size="small"
                    onClick={onClose}
                  />
                )}
              </div>
            )}
            <div className="drawer-content">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(content, document.body);
}

export default Modal;
