import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input, Textarea, Select, Checkbox, Toggle, ChipInput } from '@/components/common/Input';

describe('Input Component', () => {
  it('renders with label', () => {
    render(<Input id="test-input" label="Email" />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders without label when not provided', () => {
    render(<Input id="test-input" />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it('handles value changes', async () => {
    const user = userEvent.setup();
    render(<Input id="test-input" defaultValue="" />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'test');

    expect(input.value).toBe('test');
  });

  it('shows error state', () => {
    const { container } = render(<Input id="test-input" error="This field is required" />);

    expect(screen.getByText('This field is required')).toBeInTheDocument();
    const wrapper = container.querySelector('.input-error');
    expect(wrapper).toBeInTheDocument();
  });

  it('applies disabled state', () => {
    render(<Input id="test-input" disabled />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeDisabled();
  });

  it('shows hint text', () => {
    render(<Input id="test-input" hint="Enter your email address" />);
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();
  });

  it('shows required indicator', () => {
    render(<Input id="test-input" label="Name" required />);
    expect(screen.getByLabelText('Required')).toBeInTheDocument();
  });

  it('applies aria attributes correctly', () => {
    render(<Input id="test-input" required={true} error="Invalid" />);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('applies fullWidth class', () => {
    const { container } = render(<Input id="test-input" fullWidth />);

    const wrapper = container.querySelector('.input-full');
    expect(wrapper).toBeInTheDocument();
  });

  it('renders with icon on left', () => {
    render(<Input id="test-input" icon="📧" />);
    expect(screen.getByText('📧')).toHaveClass('input-icon-left');
  });

  it('renders with icon on right when specified', () => {
    render(<Input id="test-input" icon="✓" iconPosition="right" />);
    expect(screen.getByText('✓')).toHaveClass('input-icon-right');
  });

  it('applies size classes', () => {
    const sizes = ['small', 'medium', 'large'] as const;

    sizes.forEach((size) => {
      const { container, unmount } = render(<Input id={`test-${size}`} size={size} />);

      const inputContainer = container.querySelector(`.input-${size}`);
      expect(inputContainer).toBeInTheDocument();
      unmount();
    });
  });

  it('applies variant classes', () => {
    const variants = ['default', 'filled', 'outlined'] as const;

    variants.forEach((variant) => {
      const { container, unmount } = render(<Input id={`test-${variant}`} variant={variant} />);

      const inputContainer = container.querySelector(`.input-${variant}`);
      expect(inputContainer).toBeInTheDocument();
      unmount();
    });
  });

  it('handles focus and blur events', async () => {
    const user = userEvent.setup();
    const { container } = render(<Input id="test-input" />);

    const input = screen.getByRole('textbox');
    await user.click(input);

    const focusedContainer = container.querySelector('.input-focused');
    expect(focusedContainer).toBeInTheDocument();

    await user.click(document.body);
    expect(container.querySelector('.input-focused')).not.toBeInTheDocument();
  });
});

describe('Textarea Component', () => {
  it('renders with label', () => {
    render(<Textarea id="test-textarea" label="Comments" />);
    expect(screen.getByLabelText('Comments')).toBeInTheDocument();
  });

  it('handles value changes', async () => {
    const user = userEvent.setup();
    render(<Textarea id="test-textarea" defaultValue="" />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, 'test text');

    expect(textarea.value).toBe('test text');
  });

  it('shows error state', () => {
    render(<Textarea id="test-textarea" error="This field is required" />);

    expect(screen.getByText('This field is required')).toBeInTheDocument();
  });

  it('applies disabled state', () => {
    render(<Textarea id="test-textarea" disabled />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
  });

  it('renders with custom rows', () => {
    render(<Textarea id="test-textarea" rows={8} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('rows', '8');
  });
});

describe('Select Component', () => {
  const options = [
    { value: 'option1', label: 'Option 1' },
    { value: 'option2', label: 'Option 2' },
    { value: 'option3', label: 'Option 3' },
  ];

  it('renders with options', () => {
    render(<Select id="test-select" label="Choose" options={options} />);

    expect(screen.getByText('Option 1')).toBeInTheDocument();
    expect(screen.getByText('Option 2')).toBeInTheDocument();
    expect(screen.getByText('Option 3')).toBeInTheDocument();
  });

  it('renders with placeholder', () => {
    render(<Select id="test-select" options={options} placeholder="Select an option" />);

    expect(screen.getByText('Select an option')).toBeInTheDocument();
  });

  it('handles selection', async () => {
    const user = userEvent.setup();
    render(<Select id="test-select" options={options} />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await user.selectOptions(select, 'option2');

    expect(select.value).toBe('option2');
  });

  it('shows error state', () => {
    render(<Select id="test-select" options={options} error="Invalid selection" />);

    expect(screen.getByText('Invalid selection')).toBeInTheDocument();
  });

  it('applies disabled state', () => {
    render(<Select id="test-select" options={options} disabled={true} />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeDisabled();
  });

  it('disables specific options', () => {
    const optionsWithDisabled = [
      { value: 'option1', label: 'Option 1' },
      { value: 'option2', label: 'Option 2', disabled: true },
    ];

    render(<Select id="test-select" options={optionsWithDisabled} />);

    const option2 = screen.getByText('Option 2') as HTMLOptionElement;
    expect(option2).toBeDisabled();
  });
});

describe('Checkbox Component', () => {
  it('renders with label', () => {
    render(<Checkbox label="Agree" checked={false} onChange={vi.fn()} />);

    expect(screen.getByText('Agree')).toBeInTheDocument();
  });

  it('handles value changes', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Checkbox label="Agree" checked={false} onChange={handleChange} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    await user.click(checkbox);

    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it('applies disabled state', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Checkbox label="Disabled" checked={false} onChange={handleChange} disabled={true} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox).toBeDisabled();

    await user.click(checkbox);
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('shows checked state', () => {
    render(<Checkbox label="Checked" checked={true} onChange={vi.fn()} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox).toBeChecked();
  });
});

describe('Toggle Component', () => {
  it('renders with label', () => {
    render(<Toggle label="Dark Mode" checked={false} onChange={vi.fn()} />);

    expect(screen.getByText('Dark Mode')).toBeInTheDocument();
  });

  it('handles value changes', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Toggle label="Toggle" checked={false} onChange={handleChange} />);

    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    await user.click(toggle);

    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it('applies disabled state', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Toggle label="Disabled" checked={false} onChange={handleChange} disabled={true} />);

    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    expect(toggle).toBeDisabled();

    await user.click(toggle);
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('applies size classes', () => {
    const sizes = ['small', 'medium', 'large'] as const;

    sizes.forEach((size) => {
      const { container, unmount } = render(
        <Toggle size={size} checked={false} onChange={vi.fn()} />
      );

      const wrapper = container.querySelector(`.toggle-${size}`);
      expect(wrapper).toBeInTheDocument();
      unmount();
    });
  });

  it('shows on state when checked', () => {
    const { container } = render(<Toggle checked={true} onChange={vi.fn()} />);

    const track = container.querySelector('.toggle-on');
    expect(track).toBeInTheDocument();
  });
});

describe('ChipInput Component', () => {
  it('renders with label', () => {
    render(<ChipInput value={0} onChange={vi.fn()} label="Bet Amount" />);

    expect(screen.getByText('Bet Amount')).toBeInTheDocument();
  });

  it('handles value changes', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    // Use a wrapper to test controlled component behavior
    const Wrapper = () => {
      const [val, setVal] = useState(100);
      return (
        <ChipInput
          value={val}
          onChange={(v: number) => {
            setVal(v);
            handleChange(v);
          }}
        />
      );
    };

    render(<Wrapper />);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '200');

    expect(handleChange).toHaveBeenCalledWith(200);
  });

  it('increments value with plus button', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    const { container } = render(<ChipInput value={100} onChange={handleChange} step={10} />);

    const buttons = container.querySelectorAll('button');
    const plusButton = buttons[1];

    await user.click(plusButton);

    expect(handleChange).toHaveBeenCalledWith(110);
  });

  it('decrements value with minus button', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    const { container } = render(<ChipInput value={100} onChange={handleChange} step={10} />);

    const buttons = container.querySelectorAll('button');
    const minusButton = buttons[0];

    await user.click(minusButton);

    expect(handleChange).toHaveBeenCalledWith(90);
  });

  it('respects min value', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    const { container } = render(
      <ChipInput
        value={10}
        onChange={handleChange}
        min={0}
        step={15} // Exceeds margin to cross 0
      />
    );

    const buttons = container.querySelectorAll('button');
    const minusButton = buttons[0];

    await user.click(minusButton);

    expect(handleChange).toHaveBeenCalledWith(0); // 10 - 15 = -5 => clamps to 0
  });

  it('respects max value', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    const { container } = render(
      <ChipInput
        value={90}
        onChange={handleChange}
        max={100}
        step={15} // Exceeds margin to cross 100
      />
    );

    const buttons = container.querySelectorAll('button');
    const plusButton = buttons[1];

    await user.click(plusButton);

    expect(handleChange).toHaveBeenCalledWith(100); // 90 + 15 = 105 => clamps to 100
  });

  it('renders preset buttons', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(
      <ChipInput
        value={0}
        onChange={handleChange}
        presets={[
          { label: '10', value: 10 },
          { label: '50', value: 50 },
          { label: '100', value: 100 },
        ]}
      />
    );

    await user.click(screen.getByText('50'));

    expect(handleChange).toHaveBeenCalledWith(50);
  });

  it('applies disabled state', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    const { container } = render(<ChipInput value={100} onChange={handleChange} disabled={true} />);

    const buttons = container.querySelectorAll('button');
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();

    await user.click(buttons[0]);
    expect(handleChange).not.toHaveBeenCalled();
  });
});
