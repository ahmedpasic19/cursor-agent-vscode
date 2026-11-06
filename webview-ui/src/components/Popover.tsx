import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose(): void;
  /** Where the popover opens relative to its (position: relative) parent. */
  placement: 'above' | 'below';
  align?: 'left' | 'right' | 'stretch';
  className?: string;
  /** Muted header line (e.g. "Modes", or "<model> · <description>"). */
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  label: string;
}

/**
 * Claude Code–style floating panel: surface background, hairline border, soft shadow.
 * Closes on outside mousedown and Escape. Keyboard navigation is up to the children.
 */
export function Popover({ open, onClose, placement, align = 'left', className, header, footer, children, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      // Clicks on the trigger (the popover's parent) toggle it themselves.
      if (el && !el.contains(e.target as Node) && !el.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={ref} className={`popover ${placement} align-${align} ${className ?? ''}`} role="dialog" aria-label={label}>
      {header && <div className="popover-header">{header}</div>}
      {children}
      {footer && <div className="popover-footer">{footer}</div>}
    </div>
  );
}

/** Two-line option row with an optional leading icon and a trailing check for the current item. */
export function OptionRow({
  icon,
  label,
  description,
  current,
  active,
  disabled,
  onPick,
  onHover,
  trailing,
}: {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  current?: boolean;
  active?: boolean;
  disabled?: boolean;
  onPick(): void;
  onHover?(): void;
  trailing?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={!!current}
      aria-disabled={disabled}
      className={`option-row${active ? ' active' : ''}${current ? ' current' : ''}${disabled ? ' disabled' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onPick();
      }}
    >
      {icon && <span className="option-icon">{icon}</span>}
      <span className="option-text">
        <span className="option-label">{label}</span>
        {description && <span className="option-desc">{description}</span>}
      </span>
      {trailing}
      {current && (
        <span className="option-check" aria-hidden>
          ✓
        </span>
      )}
    </div>
  );
}
