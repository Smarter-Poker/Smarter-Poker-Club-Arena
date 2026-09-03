/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMON COMPONENTS INDEX — Centralized Exports
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Toast Notification System
export { ToastProvider, useToast, type ToastType } from './Toast';

// Confirmation Modal
export { ConfirmModal, type ConfirmModalProps } from './ConfirmModal';

// Empty State Component
export { EmptyState } from './EmptyState';

// Error Boundary
export { default as ErrorBoundary } from './ErrorBoundary';

// Online Indicator
export { OnlineIndicator } from './OnlineIndicator';

// Skeleton Loading Components
export {
  Skeleton,
  SkeletonText,
  SkeletonButton,
  SkeletonCard,
  SkeletonTableRow,
  SkeletonPokerSeat,
  SkeletonClubCard,
  SkeletonTournamentCard,
  SkeletonListItem,
  SkeletonPage,
} from './Skeleton';

// Loading Spinner Components
export {
  LoadingSpinner,
  InlineLoader,
  PageLoader,
  TableLoader,
  CardLoader,
} from './LoadingSpinner';

// Badge Components
export {
  Badge,
  VIPBadge,
  StatusBadge,
  PositionBadge,
  TournamentStatusBadge,
  CountBadge,
  NewBadge,
  ProBadge,
} from './Badge';

// Button Components
export { Button, IconButton, ButtonGroup, PokerActionButton } from './Button';

// Card Components
export { Card, CardHeader, CardContent, CardFooter, StatCard, FeatureCard } from './Card';

// Input Components
export { Input, Textarea, Select, Checkbox, Toggle, ChipInput } from './Input';

// Modal Components
export { Modal, ModalFooter, AlertDialog, Drawer } from './Modal';

// Tooltip Components
export { Tooltip, InfoTooltip, Popover } from './Tooltip';

// Progress Components
export { Progress, CircularProgress, StepProgress, BlindLevelProgress } from './Progress';

// Tabs Components
export { Tabs, TabList, Tab, TabPanel, SimpleTabs } from './Tabs';

// Dropdown Components
export { Dropdown, DropdownItem, DropdownDivider, DropdownLabel, ActionMenu } from './Dropdown';

// Table Components
export { Table, SimpleTable, LeaderboardTable } from './Table';

// Notification Components
export {
  Notification,
  NotificationList,
  NotificationBadge,
  NotificationBell,
  type NotificationItem,
} from './Notification';

// Search Components
export { SearchInput, SearchWithResults, FilterChips } from './Search';

// Animated Number Display
export { AnimatedNumber } from './AnimatedNumber';
