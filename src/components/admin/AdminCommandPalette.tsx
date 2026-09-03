/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AdminCommandPalette — Cmd+K Quick Access Admin Actions
 *  Spotlight-style search overlay for navigating admin pages quickly.
 *  Supports keyboard navigation, fuzzy filtering, and action shortcuts.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

interface CommandAction {
  id: string;
  label: string;
  icon: string;
  description: string;
  action: () => void;
  category: string;
}

interface AdminCommandPaletteProps {
  clubId?: string;
  isOwner?: boolean;
}

export default function AdminCommandPalette({ clubId, isOwner }: AdminCommandPaletteProps) {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Register Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const allActions = useMemo<CommandAction[]>(() => {
    const actions: CommandAction[] = [];

    if (clubId) {
      // Navigation
      actions.push(
        {
          id: 'nav-overview',
          label: 'Go To Overview',
          icon: '▦',
          description: 'Club Overview & Activity',
          action: () => navigate(`/clubs/${clubId}`),
          category: 'Navigation',
        },
        {
          id: 'nav-tables',
          label: 'View Tables',
          icon: '♠',
          description: 'Active Tables & Management',
          action: () => navigate(`/clubs/${clubId}`),
          category: 'Navigation',
        },
        {
          id: 'nav-members',
          label: 'Member Directory',
          icon: '◉',
          description: 'View And Manage Members',
          action: () => navigate(`/clubs/${clubId}`),
          category: 'Navigation',
        },
        {
          id: 'nav-agents',
          label: 'Agent Management',
          icon: '◈',
          description: 'Manage Agents & Hierarchy',
          action: () => navigate(`/clubs/${clubId}/agents`),
          category: 'Navigation',
        },
        {
          id: 'nav-financials',
          label: 'Club Financials',
          icon: '◆',
          description: 'Revenue & Transactions',
          action: () => navigate(`/clubs/${clubId}/financials`),
          category: 'Navigation',
        },
        {
          id: 'nav-stats',
          label: 'Player Stats',
          icon: '▲',
          description: 'Detailed Player Statistics',
          action: () => navigate(`/stats`),
          category: 'Navigation',
        }
      );

      // Actions
      actions.push(
        {
          id: 'act-create-table',
          label: 'Create New Table',
          icon: '+',
          description: 'Set Up A New Poker Table',
          action: () => navigate(`/clubs/${clubId}/create-table`),
          category: 'Actions',
        },
        {
          id: 'act-invite',
          label: 'Invite Players',
          icon: '✉',
          description: 'Send Club Invite Links',
          action: () => navigate(`/invite/${clubId}`),
          category: 'Actions',
        },
        {
          id: 'act-announce',
          label: 'Post Announcement',
          icon: '◉',
          description: 'Broadcast To All Members',
          action: () => navigate(`/clubs/${clubId}/announcements`),
          category: 'Actions',
        }
      );

      if (isOwner) {
        actions.push({
          id: 'act-settings',
          label: 'Club Settings',
          icon: '⚙',
          description: 'Configure Rules & Privacy',
          action: () => navigate(`/clubs/${clubId}/settings`),
          category: 'Admin',
        });
      }
    }

    // Global
    actions.push(
      {
        id: 'gl-home',
        label: 'Home',
        icon: '⌂',
        description: 'Return To Dashboard',
        action: () => navigate('/'),
        category: 'Global',
      },
      {
        id: 'gl-clubs',
        label: 'My Clubs',
        icon: '◆',
        description: 'View All Clubs',
        action: () => navigate('/clubs'),
        category: 'Global',
      }
    );

    return actions;
  }, [clubId, isOwner, navigate]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allActions;
    const q = search.toLowerCase();
    return allActions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
    );
  }, [allActions, search]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        filtered[selectedIndex].action();
        setIsOpen(false);
      }
    },
    [filtered, selectedIndex]
  );

  if (!isOpen) return null;

  // Group by category
  const grouped = new Map<string, CommandAction[]>();
  filtered.forEach((a) => {
    if (!grouped.has(a.category)) grouped.set(a.category, []);
    grouped.get(a.category)!.push(a);
  });

  let globalIdx = 0;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setIsOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          zIndex: 2000,
          animation: 'fadeIn 0.15s ease',
        }}
      />

      {/* Palette */}
      <div
        style={{
          position: 'fixed',
          top: '15%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(500px, 90vw)',
          background: 'linear-gradient(180deg, #1e1e32, #14141f)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '16px',
          zIndex: 2001,
          overflow: 'hidden',
          animation: 'animationsSlideDown 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6), 0 0 20px rgba(0, 212, 255, 0.1)',
        }}
      >
        {/* Search Input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '14px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.5 }}
          >
            <circle cx="7" cy="7" r="5.5" stroke="#aaa" strokeWidth="1.5" />
            <line
              x1="11"
              y1="11"
              x2="14"
              y2="14"
              stroke="#aaa"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type A Command Or Search..."
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#fff',
              fontSize: '0.9rem',
            }}
          />
          <kbd
            style={{
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '4px',
              color: '#6a7a8a',
              fontSize: '0.6rem',
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          style={{
            maxHeight: '50vh',
            overflowY: 'auto',
            padding: '8px 0',
          }}
        >
          {filtered.length === 0 && (
            <div
              style={{ padding: '2rem', textAlign: 'center', color: '#6a7a8a', fontSize: '0.8rem' }}
            >
              No Results Found
            </div>
          )}
          {Array.from(grouped.entries()).map(([category, actions]) => (
            <div key={category}>
              <div
                style={{
                  padding: '8px 16px 4px',
                  fontSize: '0.6rem',
                  fontWeight: 600,
                  color: '#6a7a8a',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                {category}
              </div>
              {actions.map((action) => {
                const idx = globalIdx++;
                return (
                  <div
                    key={action.id}
                    onClick={() => {
                      action.action();
                      setIsOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '10px 16px',
                      cursor: 'pointer',
                      background: idx === selectedIndex ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <span style={{ fontSize: '1rem', flexShrink: 0 }}>{action.icon}</span>
                    <div style={{ flex: 1 }}>
                      <span
                        style={{
                          color: '#fff',
                          fontSize: '0.8rem',
                          fontWeight: 500,
                          display: 'block',
                        }}
                      >
                        {action.label}
                      </span>
                      <span style={{ color: '#6a7a8a', fontSize: '0.65rem' }}>
                        {action.description}
                      </span>
                    </div>
                    {idx === selectedIndex && (
                      <span
                        style={{
                          fontSize: '0.55rem',
                          color: '#00d4ff',
                          padding: '2px 6px',
                          background: 'rgba(0,212,255,0.1)',
                          borderRadius: '4px',
                        }}
                      >
                        ⏎ Enter
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '1rem',
            padding: '8px 16px',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            fontSize: '0.55rem',
            color: '#6a7a8a',
          }}
        >
          <span>↑↓ Navigate</span>
          <span>⏎ Select</span>
          <span>ESC Close</span>
        </div>
      </div>
    </>
  );
}
