import type { ViewId } from "../types/dashboard";

export const viewIds: ViewId[] = [
  "login", "live", "overview", "devices", "device-360-system",
  "task-queue-and-vision", "live-desktop-studio", "interactive-terminal",
  "autonomous-workflows", "fleet-operations", "ai-api-and-agents",
  "human-approvals", "security-policies", "audit-trail", "mcp-and-oauth",
  "diagnostics-and-logs",
];

/** Live-workspace sections addressable as #/live?section=<section> (UX-16). */
export const liveSections = ["devices", "tasks", "approvals", "notifications", "audit", "policies", "connections", "logs", "users"] as const;
export type LiveSection = (typeof liveSections)[number];
/** Device-workspace tabs addressable as #/live?device=<id>&tab=<tab> (UX-16). */
export const liveTabs = ["details", "tasks", "terminal", "desktop"] as const;
export type LiveTab = (typeof liveTabs)[number];

/** Task-list statuses addressable as #/task-queue-and-vision?status=<status> (UX-13). */
export const taskStatuses = ["all", "completed", "running", "needs_approval", "failed"] as const;
export type TaskStatusFilter = (typeof taskStatuses)[number];

export interface Route {
  view: ViewId;
  device?: string;
  /** Live-workspace section; only parsed for #/live (UX-13). */
  section?: LiveSection;
  /** Device-workspace tab; only parsed for #/live (UX-13). */
  tab?: LiveTab;
  /** Task id deep link; only parsed for #/task-queue-and-vision (UX-13). */
  task?: string;
  /** Workflow id deep link; only parsed for #/autonomous-workflows (UX-13). */
  workflow?: string;
  /** Desktop session id deep link; only parsed for #/live-desktop-studio (UX-13). */
  session?: string;
  /** List search text; only parsed for #/task-queue-and-vision (UX-13). */
  q?: string;
  /** Task-list status filter; only parsed for #/task-queue-and-vision (UX-13). */
  status?: TaskStatusFilter;
  /** True when the hash path is not a known view (resolves to login, UX-13). */
  unknownHash: boolean;
}

export interface RouteExtra {
  section?: string;
  tab?: string;
  task?: string;
  workflow?: string;
  session?: string;
  q?: string;
  status?: string;
  /** When true, replace the current history entry instead of pushing one
      (filter typing; UX-13). */
  replace?: boolean;
}

export function readRoute(): Route {
  if (typeof window === "undefined") return { view: "login", unknownHash: false };
  const [path, query] = window.location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const known = viewIds.includes(path as ViewId);
  const view: ViewId = known ? (path as ViewId) : "login";
  const sectionRaw = params.get("section");
  const tabRaw = params.get("tab");
  const statusRaw = params.get("status");
  return {
    view,
    device: params.get("device") || undefined,
    section:
      view === "live" && sectionRaw && (liveSections as readonly string[]).includes(sectionRaw)
        ? (sectionRaw as LiveSection)
        : undefined,
    tab:
      view === "live" && tabRaw && (liveTabs as readonly string[]).includes(tabRaw)
        ? (tabRaw as LiveTab)
        : undefined,
    // Entity deep links are view-scoped: a ?task= on any other route is
    // not a selection, so it is ignored rather than applied elsewhere.
    task: view === "task-queue-and-vision" ? params.get("task") || undefined : undefined,
    workflow: view === "autonomous-workflows" ? params.get("workflow") || undefined : undefined,
    session: view === "live-desktop-studio" ? params.get("session") || undefined : undefined,
    q: view === "task-queue-and-vision" ? params.get("q") || undefined : undefined,
    status:
      view === "task-queue-and-vision" && statusRaw && (taskStatuses as readonly string[]).includes(statusRaw)
        ? (statusRaw as TaskStatusFilter)
        : undefined,
    // An empty hash (#/ or none) is the default landing, not an unknown page.
    unknownHash: path !== "" && !known,
  };
}

export function writeRoute(view: ViewId, device?: string, extra?: RouteExtra) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  if (device) params.set("device", device);
  if (view === "live") {
    // Navigating (back) to Live home keeps the live section/tab the user
    // was in, so a section link survives sidebar/palette navigation and a
    // refresh (UX-13); the device selection is dropped so Live home lands
    // on the section list, not a stale device workspace.
    const current = new URLSearchParams(window.location.hash.split("?")[1] || "");
    const section = extra?.section ?? current.get("section") ?? undefined;
    const tab = extra?.tab ?? current.get("tab") ?? undefined;
    if (section) params.set("section", section);
    if (tab) params.set("tab", tab);
  } else {
    if (extra?.section) params.set("section", extra.section);
    if (extra?.tab) params.set("tab", extra.tab);
    // Entity deep links (UX-13): written by the owning view when its
    // selection changes, so the link survives refresh and can be shared.
    if (extra?.task) params.set("task", extra.task);
    if (extra?.workflow) params.set("workflow", extra.workflow);
    if (extra?.session) params.set("session", extra.session);
    if (extra?.q) params.set("q", extra.q);
    if (extra?.status) params.set("status", extra.status);
  }
  const query = params.toString();
  const next = `#/${view}${query ? `?${query}` : ""}`;
  if (window.location.hash !== next) {
    if (extra?.replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
  }
}

/**
 * Merge a patch into the current hash query without changing the view
 * (UX-13). Other params already in the hash are preserved. Pass
 * `undefined` (or "") to drop a param. Defaults to pushState; pass
 * replace=true for filter typing so keystrokes do not spam history.
 */
export function updateRouteParams(
  patch: { task?: string; workflow?: string; session?: string; q?: string; status?: string },
  replace = false
) {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "#/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }
  const next = params.toString() ? `${path}?${params.toString()}` : path;
  if (next === hash) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}
