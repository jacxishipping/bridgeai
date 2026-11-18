/**
 * Global notice (toast) system (UX-06) — the ONE feedback mechanism for
 * post-action results across the app.
 *
 * Policy:
 * - success / info notices auto-dismiss after 5 s;
 * - warning / error notices persist until the user dismisses them;
 * - every notice has a dismiss (X) button;
 * - success/info render with role="status", warning/error with
 *   role="alert" (see NoticeStack).
 *
 * Usage:
 *   import { pushNotice, useNotice } from "./state/notices";
 *   pushNotice({ tone: "success", title: "Device enrolled" });
 *   pushNotice({ tone: "error", title: "Dispatch failed", message: "…" });
 *   const { push } = useNotice(); // same store, React hook form
 *
 * <NoticeStack /> is mounted once at the App level (src/App.tsx) so it
 * renders on every route, including #/live which bypasses AppShell.
 * Do NOT create per-view inline notice mechanisms — push here instead.
 * Do NOT render error text inside a success-styled notice.
 */
import { useSyncExternalStore } from "react";

export type NoticeTone = "success" | "error" | "info" | "warning";

export interface Notice {
  id: number;
  tone: NoticeTone;
  title: string;
  message?: string;
  /** Optional action link rendered as an anchor inside the notice. */
  actionLabel?: string;
  actionHref?: string;
}

export interface PushNoticeInput {
  tone?: NoticeTone;
  title: string;
  message?: string;
  actionLabel?: string;
  actionHref?: string;
}

let nextId = 1;
let notices: Notice[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

/** Push a notice; returns its id (pass it to dismissNotice to clear early). */
export function pushNotice(input: PushNoticeInput): number {
  const notice: Notice = {
    id: nextId++,
    tone: input.tone ?? "info",
    title: input.title,
    message: input.message,
    actionLabel: input.actionLabel,
    actionHref: input.actionHref,
  };
  notices = [...notices, notice];
  notify();
  return notice.id;
}

/** Remove a notice by id. No-op for unknown ids. */
export function dismissNotice(id: number): void {
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  notify();
}

/** Read the current notice list; re-renders when it changes. */
export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => notices,
    () => [],
  );
}

/**
 * Hook form of the notice store: push/dismiss plus the live list.
 * Prefer the module-level pushNotice() from non-component code
 * (store callbacks, API wrappers); use this hook inside components.
 */
export function useNotice() {
  const list = useNotices();
  return { notices: list, push: pushNotice, dismiss: dismissNotice };
}
