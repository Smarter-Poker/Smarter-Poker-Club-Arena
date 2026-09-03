import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, IconButton, ButtonGroup, PokerActionButton } from '@/components/common/Button';

describe('Button Component', () => {
  it('renders with text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('handles click events', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);

    await user.click(screen.getByText('Click'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('shows loading state and disables button', async () => {
    const handleClick = vi.fn();
    const { rerender } = render(<Button onClick={handleClick}>Click</Button>);

    expect(screen.queryByText('Click')).toBeInTheDocument();

    rerender(
      <Button loading={true} onClick={handleClick}>
        Click
      </Button>
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });

  it('is disabled when disabled prop set', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(
      <Button disabled onClick={handleClick}>
        Disabled
      </Button>
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();

    await user.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('applies variant classes correctly', () => {
    const variants = [
      'primary',
      'secondary',
      'ghost',
      'danger',
      'success',
      'warning',
      'gold',
    ] as const;

    variants.forEach((variant) => {
      const { unmount } = render(<Button variant={variant}>Test</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass(`btn-${variant}`);
      unmount();
    });
  });

  it('applies size classes correctly', () => {
    const sizes = ['small', 'medium', 'large'] as const;

    sizes.forEach((size) => {
      const { unmount } = render(<Button size={size}>Test</Button>);
      const button = screen.getByRole('button');
      expect(button).toHaveClass(`btn-${size}`);
      unmount();
    });
  });

  it('applies fullWidth class when set', () => {
    render(<Button fullWidth>Full Width</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('btn-full');
  });

  it('renders with icon on left by default', () => {
    render(<Button icon="✓">With Icon</Button>);
    const iconSpan = screen.getByText('✓');
    expect(iconSpan).toHaveClass('btn-icon-left');
  });

  it('renders with icon on right when specified', () => {
    render(
      <Button icon="→" iconPosition="right">
        With Icon
      </Button>
    );
    const iconSpan = screen.getByText('→');
    expect(iconSpan).toHaveClass('btn-icon-right');
  });
});

describe('IconButton Component', () => {
  it('renders with aria-label', () => {
    render(<IconButton icon="✓" label="Confirm" />);
    const button = screen.getByLabelText('Confirm');
    expect(button).toBeInTheDocument();
  });

  it('handles click events', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<IconButton icon="✓" label="Test" onClick={handleClick} />);

    await user.click(screen.getByLabelText('Test'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('is disabled when disabled prop set', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<IconButton icon="✓" label="Test" disabled onClick={handleClick} />);

    const button = screen.getByLabelText('Test');
    expect(button).toBeDisabled();

    await user.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('is disabled when loading', () => {
    render(<IconButton icon="✓" label="Test" loading={true} />);
    const button = screen.getByLabelText('Test');
    expect(button).toBeDisabled();
  });
});

describe('ButtonGroup Component', () => {
  it('renders children', () => {
    render(
      <ButtonGroup>
        <Button>Button 1</Button>
        <Button>Button 2</Button>
      </ButtonGroup>
    );

    expect(screen.getByText('Button 1')).toBeInTheDocument();
    expect(screen.getByText('Button 2')).toBeInTheDocument();
  });

  it('applies orientation class', () => {
    const { container } = render(
      <ButtonGroup orientation="vertical">
        <Button>Test</Button>
      </ButtonGroup>
    );

    const group = container.querySelector('.btn-group-vertical');
    expect(group).toBeInTheDocument();
  });

  it('applies spacing class', () => {
    const { container } = render(
      <ButtonGroup spacing="loose">
        <Button>Test</Button>
      </ButtonGroup>
    );

    const group = container.querySelector('.btn-group-loose');
    expect(group).toBeInTheDocument();
  });
});

describe('PokerActionButton Component', () => {
  it('renders fold action', () => {
    render(<PokerActionButton action="fold" onClick={vi.fn()} />);
    expect(screen.getByText('Fold')).toBeInTheDocument();
  });

  it('renders check action', () => {
    render(<PokerActionButton action="check" onClick={vi.fn()} />);
    expect(screen.getByText('Check')).toBeInTheDocument();
  });

  it('renders call action', () => {
    render(<PokerActionButton action="call" onClick={vi.fn()} />);
    expect(screen.getByText('Call')).toBeInTheDocument();
  });

  it('renders bet action', () => {
    render(<PokerActionButton action="bet" onClick={vi.fn()} />);
    expect(screen.getByText('Bet')).toBeInTheDocument();
  });

  it('renders raise action', () => {
    render(<PokerActionButton action="raise" onClick={vi.fn()} />);
    expect(screen.getByText('Raise')).toBeInTheDocument();
  });

  it('renders all-in action', () => {
    render(<PokerActionButton action="all_in" onClick={vi.fn()} />);
    expect(screen.getByText('All-In')).toBeInTheDocument();
  });

  it('displays amount when provided', () => {
    render(<PokerActionButton action="bet" amount={1000} onClick={vi.fn()} />);
    expect(screen.getByText('1,000')).toBeInTheDocument();
  });

  it('displays hotkey when provided', () => {
    render(<PokerActionButton action="fold" hotkey="F" onClick={vi.fn()} />);
    expect(screen.getByText('F')).toBeInTheDocument();
  });

  it('handles click events', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<PokerActionButton action="bet" onClick={handleClick} />);

    await user.click(screen.getByText('Bet'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('is disabled when disabled prop set', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<PokerActionButton action="bet" disabled onClick={handleClick} />);

    await user.click(screen.getByText('Bet'));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('applies correct variant for each action', () => {
    const tests = [
      { action: 'fold' as const, variant: 'danger' },
      { action: 'check' as const, variant: 'secondary' },
      { action: 'call' as const, variant: 'success' },
      { action: 'bet' as const, variant: 'primary' },
      { action: 'raise' as const, variant: 'warning' },
      { action: 'all_in' as const, variant: 'gold' },
    ];

    tests.forEach(({ action, variant }) => {
      const { unmount } = render(<PokerActionButton action={action} onClick={vi.fn()} />);
      const button = screen.getByRole('button');
      expect(button).toHaveClass(`btn-${variant}`);
      unmount();
    });
  });
});
