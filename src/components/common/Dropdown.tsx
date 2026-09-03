/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DROPDOWN — Dropdown Menu Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import './Dropdown.css';

interface DropdownProps {
  trigger: React.ReactElement;
  children: React.ReactNode;
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  closeOnSelect?: boolean;
  className?: string;
}

/**
 * Dropdown container
 */
export function Dropdown({
  trigger,
  children,
  position = 'bottom-left',
  closeOnSelect = true,
  className = '',
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggleDropdown = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Position calculation
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const gap = 4;

      let top = 0;
      let left = 0;

      switch (position) {
        case 'bottom-left':
          top = rect.bottom + gap;
          left = rect.left;
          break;
        case 'bottom-right':
          top = rect.bottom + gap;
          left = rect.right;
          break;
        case 'top-left':
          top = rect.top - gap;
          left = rect.left;
          break;
        case 'top-right':
          top = rect.top - gap;
          left = rect.right;
          break;
      }

      setCoords({ top, left });
    }
  }, [isOpen, position]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        closeDropdown();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, closeDropdown]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDropdown();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeDropdown]);

  const handleMenuClick = () => {
    if (closeOnSelect) {
      closeDropdown();
    }
  };

  const menuContent = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          className={`dropdown-menu dropdown-${position} ${className}`}
          style={{ top: coords.top, left: coords.left }}
          initial={{ opacity: 0, scale: 0.95, y: position.startsWith('top') ? 10 : -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          onClick={handleMenuClick}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <span ref={triggerRef} onClick={toggleDropdown} style={{ display: 'inline-flex' }}>
        {trigger}
      </span>
      {createPortal(menuContent, document.body)}
    </>
  );
}

/**
 * Dropdown menu item
 */
export function DropdownItem({
  children,
  icon,
  onClick,
  disabled = false,
  danger = false,
  className = '',
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`dropdown-item ${danger ? 'dropdown-item-danger' : ''} ${disabled ? 'dropdown-item-disabled' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <span className="dropdown-item-icon">{icon}</span>}
      <span className="dropdown-item-label">{children}</span>
    </button>
  );
}

/**
 * Dropdown divider
 */
export function DropdownDivider() {
  return <div className="dropdown-divider" />;
}

/**
 * Dropdown header/label
 */
export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return <div className="dropdown-label">{children}</div>;
}

/**
 * Action menu (common dropdown with multiple actions)
 */
export function ActionMenu({
  actions,
  trigger,
}: {
  actions: Array<{
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    divider?: boolean;
  }>;
  trigger: React.ReactElement;
}) {
  return (
    <Dropdown trigger={trigger}>
      {actions.map((action, index) => (
        <React.Fragment key={index}>
          {action.divider && <DropdownDivider />}
          <DropdownItem
            icon={action.icon}
            onClick={action.onClick}
            disabled={action.disabled}
            danger={action.danger}
          >
            {action.label}
          </DropdownItem>
        </React.Fragment>
      ))}
    </Dropdown>
  );
}

export default Dropdown;
