/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ☰ TABLE MENU — Hamburger Menu for Table Actions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Comprehensive table menu with:
 * - Quick actions (leave, sit out, rebuy)
 * - Settings access
 * - Hand history
 * - Help & feedback
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import './TableMenu.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MenuAction {
    id: string;
    label: string;
    icon: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
    badge?: string | number;
}

export interface MenuSection {
    title?: string;
    actions: MenuAction[];
}

export interface TableMenuProps {
    isOpen: boolean;
    onClose: () => void;
    onToggle: () => void;
    sections: MenuSection[];
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    tableName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT MENU SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function createDefaultMenuSections(handlers: {
    onSitOut?: () => void;
    onStandUp?: () => void;
    onRebuy?: () => void;
    onSettings?: () => void;
    onHandHistory?: () => void;
    onLeaderboard?: () => void;
    onHelp?: () => void;
    onLeaveTable?: () => void;
}): MenuSection[] {
    return [
        {
            title: 'Quick Actions',
            actions: [
                { id: 'sitout', label: 'Sit Out Next Hand', icon: '⏸️', onClick: handlers.onSitOut || (() => { }) },
                { id: 'standup', label: 'Stand Up', icon: '🚶', onClick: handlers.onStandUp || (() => { }) },
                { id: 'rebuy', label: 'Add Chips', icon: '💰', onClick: handlers.onRebuy || (() => { }) },
            ],
        },
        {
            title: 'Table Info',
            actions: [
                { id: 'history', label: 'Hand History', icon: '📜', onClick: handlers.onHandHistory || (() => { }) },
                { id: 'leaderboard', label: 'Leaderboard', icon: '🏆', onClick: handlers.onLeaderboard || (() => { }) },
                { id: 'settings', label: 'Settings', icon: '⚙️', onClick: handlers.onSettings || (() => { }) },
            ],
        },
        {
            title: 'Support',
            actions: [
                { id: 'help', label: 'Help & Rules', icon: '❓', onClick: handlers.onHelp || (() => { }) },
            ],
        },
        {
            actions: [
                { id: 'leave', label: 'Leave Table', icon: '🚪', onClick: handlers.onLeaveTable || (() => { }), danger: true },
            ],
        },
    ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableMenu({
    isOpen,
    onClose,
    onToggle,
    sections,
    position = 'top-right',
    tableName,
}: TableMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [isOpen, onClose]);

    // Close on escape
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            return () => document.removeEventListener('keydown', handleEscape);
        }
    }, [isOpen, onClose]);

    const handleActionClick = useCallback((action: MenuAction) => {
        if (action.disabled) return;
        action.onClick();
        onClose();
    }, [onClose]);

    return (
        <div className={`table-menu table-menu--${position}`} ref={menuRef}>
            {/* Hamburger Button */}
            <button
                className={`table-menu__trigger ${isOpen ? 'table-menu__trigger--active' : ''}`}
                onClick={onToggle}
                aria-label="Menu"
            >
                <span className="table-menu__hamburger">
                    <span />
                    <span />
                    <span />
                </span>
            </button>

            {/* Dropdown */}
            {isOpen && (
                <div className="table-menu__dropdown">
                    {/* Header */}
                    {tableName && (
                        <div className="table-menu__header">
                            <span className="table-menu__table-name">{tableName}</span>
                        </div>
                    )}

                    {/* Sections */}
                    <div className="table-menu__body">
                        {sections.map((section, sIdx) => (
                            <div key={sIdx} className="table-menu__section">
                                {section.title && (
                                    <span className="table-menu__section-title">{section.title}</span>
                                )}
                                {section.actions.map((action) => (
                                    <button
                                        key={action.id}
                                        className={`table-menu__action ${action.danger ? 'table-menu__action--danger' : ''} ${action.disabled ? 'table-menu__action--disabled' : ''}`}
                                        onClick={() => handleActionClick(action)}
                                        disabled={action.disabled}
                                    >
                                        <span className="table-menu__action-icon">{action.icon}</span>
                                        <span className="table-menu__action-label">{action.label}</span>
                                        {action.badge && (
                                            <span className="table-menu__action-badge">{action.badge}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default TableMenu;
