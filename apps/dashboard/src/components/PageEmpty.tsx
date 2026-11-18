import React from "react";
import { EmptyState } from "../ui";

/**
 * Thin wrapper around the shared EmptyState (UX-35). Kept because other
 * views (ConnectionsView, DevicesView, LiveControlView, LiveDesktopView)
 * still import PageEmpty; new call sites should use EmptyState directly.
 */
export const PageEmpty: React.FC<{
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  demo?: boolean;
}> = ({ title, description, actionLabel, onAction, secondaryLabel, onSecondary, demo }) => (
  <EmptyState
    variant="card"
    demo={demo}
    title={title}
    description={description}
    actionLabel={actionLabel}
    onAction={onAction}
    secondaryLabel={secondaryLabel}
    onSecondary={onSecondary}
  />
);
