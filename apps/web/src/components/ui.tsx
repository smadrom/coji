/**
 * Reusable UI primitives for the Coji design system.
 *
 * These are thin, style-only wrappers over the tokenized classes in
 * styles.css (Card, Button, Badge, Skeleton, EmptyState). Screens compose
 * them so visual states (empty / loading / error) stay consistent.
 */

import type React from 'react';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Show a spinner and disable while true. */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="spinner" style={{ fontSize: '0.85rem' }} />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export function Card({ children, style, className }: CardProps) {
  return (
    <div className={`card${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badge — status pill
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'info' | 'accent' | 'success' | 'danger';

/** Maps a project FSM status to a badge tone + human label. */
export function statusBadge(status: string): { tone: BadgeTone; label: string } {
  switch (status) {
    case 'draft':
      return { tone: 'neutral', label: 'Draft' };
    case 'generating_images':
    case 'images_pending':
      return { tone: 'info', label: 'Generating' };
    case 'images_ready':
    case 'awaiting_decision':
      return { tone: 'accent', label: 'Review' };
    case 'animating':
      return { tone: 'info', label: 'Animating' };
    case 'clips_ready':
    case 'editing':
      return { tone: 'accent', label: 'Editing' };
    case 'rendering':
      return { tone: 'info', label: 'Rendering' };
    case 'rendered':
    case 'done':
      return { tone: 'success', label: 'Done' };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    case 'cancelled':
      return { tone: 'neutral', label: 'Cancelled' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export function Badge({
  tone = 'neutral',
  children,
  ...rest
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`badge badge--${tone}`} {...rest}>
      {children}
    </span>
  );
}

/** Convenience: render the status badge for a project status string. */
export function StatusBadge({ status }: { status: string }) {
  const { tone, label } = statusBadge(status);
  return (
    <Badge tone={tone} data-testid="status-badge" data-status={status}>
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function Skeleton({
  style,
  className,
}: { style?: React.CSSProperties; className?: string }) {
  return <div className={`skeleton${className ? ` ${className}` : ''}`} style={style} />;
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  body,
  action,
  testId,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="empty-state" data-testid={testId}>
      {icon && <div className="empty-state__icon">{icon}</div>}
      <div className="empty-state__title">{title}</div>
      {body && <div className="empty-state__body">{body}</div>}
      {action}
    </div>
  );
}
