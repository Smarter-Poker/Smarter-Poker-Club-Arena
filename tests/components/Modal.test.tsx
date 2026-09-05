import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, ModalFooter, AlertDialog, Drawer } from '@/components/common/Modal';

// Mock portal to render in the test container
vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return {
    ...actual,
    createPortal: (children: any) => children,
  };
});

describe('Modal Component', () => {
  it('renders when isOpen is true', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <div>Modal content</div>
      </Modal>
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()}>
        <div>Modal content</div>
      </Modal>
    );
    expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
  });

  it('calls onClose when clicking overlay', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const { container } = render(
      <Modal isOpen={true} onClose={handleClose} closeOnOverlay={true}>
        <div>Modal content</div>
      </Modal>
    );

    // `if (overlay)` used to guard this click, so a renamed or missing
    // backdrop passed the test by never clicking anything. Assert it exists.
    const overlay = container.querySelector('.ca-modal-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    expect(handleClose).toHaveBeenCalled();
  });

  it('does not call onClose when clicking overlay if closeOnOverlay is false', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const { container } = render(
      <Modal isOpen={true} onClose={handleClose} closeOnOverlay={false}>
        <div>Modal content</div>
      </Modal>
    );

    const overlay = container.querySelector('.ca-modal-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    expect(handleClose).not.toHaveBeenCalled();
  });

  it('calls onClose when pressing Escape', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} closeOnEscape={true}>
        <div>Modal content</div>
      </Modal>
    );

    await user.keyboard('{Escape}');
    expect(handleClose).toHaveBeenCalled();
  });

  it('does not call onClose when pressing Escape if closeOnEscape is false', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} closeOnEscape={false}>
        <div>Modal content</div>
      </Modal>
    );

    await user.keyboard('{Escape}');
    expect(handleClose).not.toHaveBeenCalled();
  });

  it('renders children content', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <div>Custom content</div>
      </Modal>
    );
    expect(screen.getByText('Custom content')).toBeInTheDocument();
  });

  it('renders with title', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Title">
        <div>Content</div>
      </Modal>
    );
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('renders close button by default', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const { container } = render(
      <Modal isOpen={true} onClose={handleClose} showCloseButton={true}>
        <div>Content</div>
      </Modal>
    );

    const closeButton = container.querySelector('[aria-label="Close"]') as HTMLElement;
    if (closeButton) {
      expect(closeButton).toBeInTheDocument();
      await user.click(closeButton);
      expect(handleClose).toHaveBeenCalled();
    }
  });

  it('does not render close button when showCloseButton is false', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} showCloseButton={false}>
        <div>Content</div>
      </Modal>
    );
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('has proper accessibility attributes', () => {
    const { container } = render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <div>Content</div>
      </Modal>
    );

    const modal = container.querySelector('[role="dialog"]');
    expect(modal).toHaveAttribute('aria-modal', 'true');
  });

  it('applies size classes', () => {
    const sizes = ['small', 'medium', 'large', 'fullscreen'] as const;

    sizes.forEach((size) => {
      const { container, unmount } = render(
        <Modal isOpen={true} onClose={vi.fn()} size={size}>
          <div>Content</div>
        </Modal>
      );

      const modal = container.querySelector(`.ca-modal--${size}`);
      expect(modal).toBeInTheDocument();
      unmount();
    });
  });

  it('hides body overflow when open', () => {
    const { unmount } = render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <div>Content</div>
      </Modal>
    );

    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('ModalFooter Component', () => {
  it('renders children', () => {
    render(
      <ModalFooter>
        <button>Button 1</button>
        <button>Button 2</button>
      </ModalFooter>
    );

    expect(screen.getByText('Button 1')).toBeInTheDocument();
    expect(screen.getByText('Button 2')).toBeInTheDocument();
  });

  it('applies alignment classes', () => {
    const alignments = ['left', 'center', 'right', 'space-between'] as const;

    alignments.forEach((align) => {
      const { container, unmount } = render(
        <ModalFooter align={align}>
          <button>Test</button>
        </ModalFooter>
      );

      const footer = container.querySelector(`.ca-modal-footer--${align}`);
      expect(footer).toBeInTheDocument();
      unmount();
    });
  });
});

describe('AlertDialog Component', () => {
  it('renders when isOpen is true', () => {
    render(
      <AlertDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Confirm Action"
        message="Are you sure?"
      />
    );
    expect(screen.getByText('Confirm Action')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(
      <AlertDialog
        isOpen={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Confirm"
        message="Are you sure?"
      />
    );
    expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
  });

  it('calls onConfirm and onClose when confirm button clicked', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();

    render(
      <AlertDialog
        isOpen={true}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title="Confirm"
        message="Are you sure?"
        confirmText="Yes"
        cancelText="No"
      />
    );

    const confirmButton = screen.getByText('Yes');
    await user.click(confirmButton);

    expect(handleConfirm).toHaveBeenCalled();
    expect(handleClose).toHaveBeenCalled();
  });

  it('calls onClose when cancel button clicked', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();

    render(
      <AlertDialog
        isOpen={true}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title="Confirm"
        message="Are you sure?"
        confirmText="Yes"
        cancelText="No"
      />
    );

    const cancelButton = screen.getByText('No');
    await user.click(cancelButton);

    expect(handleClose).toHaveBeenCalled();
    expect(handleConfirm).not.toHaveBeenCalled();
  });

  it('renders custom button text', () => {
    render(
      <AlertDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Remove Item"
        message="Remove this item?"
        confirmText="Confirm Remove"
        cancelText="Keep"
      />
    );

    expect(screen.getByText('Confirm Remove')).toBeInTheDocument();
    expect(screen.getByText('Keep')).toBeInTheDocument();
  });

  it('applies variant class to confirm button', () => {
    render(
      <AlertDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Delete Item"
        message="Are you sure?"
        variant="danger"
        confirmText="Remove"
      />
    );

    const confirmButton = screen.getByText('Remove');
    expect(confirmButton).toHaveClass('btn-danger');
  });
});

describe('Drawer Component', () => {
  it('renders when isOpen is true', () => {
    render(
      <Drawer isOpen={true} onClose={vi.fn()}>
        <div>Drawer content</div>
      </Drawer>
    );
    expect(screen.getByText('Drawer content')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(
      <Drawer isOpen={false} onClose={vi.fn()}>
        <div>Drawer content</div>
      </Drawer>
    );
    expect(screen.queryByText('Drawer content')).not.toBeInTheDocument();
  });

  it('calls onClose when clicking overlay', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const { container } = render(
      <Drawer isOpen={true} onClose={handleClose}>
        <div>Content</div>
      </Drawer>
    );

    const overlay = container.querySelector('.ca-modal-drawer-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    expect(handleClose).toHaveBeenCalled();
  });

  it('renders with title', () => {
    render(
      <Drawer isOpen={true} onClose={vi.fn()} title="Drawer Title">
        <div>Content</div>
      </Drawer>
    );
    expect(screen.getByText('Drawer Title')).toBeInTheDocument();
  });

  it('renders close button by default', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Drawer isOpen={true} onClose={handleClose} showCloseButton={true}>
        <div>Content</div>
      </Drawer>
    );

    const closeButton = screen.getByLabelText('Close');
    expect(closeButton).toBeInTheDocument();

    await user.click(closeButton);
    expect(handleClose).toHaveBeenCalled();
  });

  it('applies position classes', () => {
    const positions = ['left', 'right', 'top', 'bottom'] as const;

    positions.forEach((position) => {
      const { container, unmount } = render(
        <Drawer isOpen={true} onClose={vi.fn()} position={position}>
          <div>Content</div>
        </Drawer>
      );

      const drawer = container.querySelector(`.ca-modal-drawer--${position}`);
      expect(drawer).toBeInTheDocument();
      unmount();
    });
  });

  it('hides body overflow when open', () => {
    const { unmount } = render(
      <Drawer isOpen={true} onClose={vi.fn()}>
        <div>Content</div>
      </Drawer>
    );

    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
