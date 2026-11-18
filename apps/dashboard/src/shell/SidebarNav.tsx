import React, { useState } from "react";
import { ArrowUpRight, BookMarked, BookOpen, Server, Settings } from "lucide-react";
import { Brand } from "../Brand";
import { GlossaryModal } from "../components/Glossary";
import { useDashboardStore } from "../state/dashboardStore";
import { navigationItems, navGroupOrder } from "./navigation";
import { token, sessionToken, clearCredentials, api } from "../api";
import type { ViewId } from "../types/dashboard";

/**
 * Settings destinations (UX-35). These are links into the existing
 * sub-sections, not a new route: Policies / Devices are their own views,
 * Webhooks & alerts / Backups / Tenants live inside Security policies,
 * and Users lives in the live workspace. Kept out of `navigationItems`
 * so the nav table's 15 destinations (and their tests) stay intact.
 */
const SETTINGS_LINKS: { label: string; title: string }[] = [
  { label: "Policies", title: "Security policies" },
  { label: "Devices", title: "Device inventory" },
  { label: "Webhooks & alerts", title: "Section of Security policies" },
  { label: "Backups", title: "Section of Security policies" },
  { label: "Tenants", title: "Section of Security policies" },
  { label: "Users", title: "Live workspace — Users" },
];

/** Main-nav labels that duplicate a live-workspace section label
    (LiveWorkspace.tsx `sectionLabels`); see the note in SidebarNav. */
const LIVE_SECTION_LABELS: ReadonlySet<string> = new Set([
  "Devices", "Tasks", "Approvals", "Policies", "Connections", "Logs",
]);

/** Settings labels that duplicate a main-nav or live-workspace label. */
const DUPLICATE_SETTINGS_LABELS: ReadonlySet<string> = new Set(["Devices", "Policies", "Users"]);

export const SidebarNav: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  const currentView = useDashboardStore((s) => s.currentView);
  const setCurrentView = useDashboardStore((s) => s.setCurrentView);
  const approvals = useDashboardStore((s) => s.approvals);
  const tasks = useDashboardStore((s) => s.tasks);
  const devices = useDashboardStore((s) => s.devices);
  const pending = approvals.filter((approval) => approval.status === "pending").length;
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const offlineDevices = devices.filter((device) => device.status !== "online" && !device.revoked).length;
  const navigate = (view: ViewId) => { setCurrentView(view); onNavigate?.(); };
  const isAuth = Boolean(token() || sessionToken());
  const onLive = currentView === "live";
  // UX-25: glossary modal state (sidebar footer link, next to Docs).
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  /**
   * Accessible-name disambiguation for strict-mode duplicates on #/live
   * (e2e/density.spec.ts:61 "Devices", e2e/operations.spec.ts:101 "Logs",
   * and the same class for "Policies" at operations.spec.ts:104).
   *
   * Root cause: since UX-02 put #/live inside AppShell, the sidebar and the
   * live-workspace section nav render side by side, and several labels exist
   * in both — the sidebar's canonical destination ("Devices", "Tasks",
   * "Approvals", "Policies", "Connections", "Logs") and the workspace's
   * simplified live section of the same name (LiveWorkspace.tsx
   * `sectionLabels`). The Settings group adds a third "Devices"/"Policies"
   * ("Users" too, vs the workspace Users section).
   *
   * Fix, in this file only — the workspace section names stay canonical, so
   * the workspace-scoped tests (e2e/live-workspace.spec.ts) and the
   * unscoped live-section tests keep working, and every navigation path is
   * preserved (nothing is deleted or re-routed):
   * - Main nav, on live only: "<Label> — full view" (it opens the full
   *   view; the workspace button opens the simplified live section — the
   *   same wording LiveWorkspace uses for its "Open full … view" link).
   *   Off live the labels stay canonical, so non-live tests that click the
   *   sidebar by its plain label (e.g. dashboard.spec.ts mobile drawer)
   *   are unaffected. The badge count is appended when present, because an
   *   aria-label replaces the badge span's contribution to the name.
   * - Settings links, on all views (the duplicate exists on every view,
   *   not just live): "<Label> — Settings".
   * Each name still starts with its visible label (WCAG label-in-name).
   */
  const fullViewAriaLabel = (label: string, badgeText = ""): string | undefined =>
    onLive && LIVE_SECTION_LABELS.has(label)
      ? `${label} — full view${badgeText ? `, ${badgeText}` : ""}`
      : undefined;
  const badgeTextFor = (id: ViewId): string =>
    id === "human-approvals" && pending > 0 ? `${pending} pending`
    : id === "task-queue-and-vision" && failedTasks > 0 ? `${failedTasks} failed tasks`
    : id === "devices" && offlineDevices > 0 ? `${offlineDevices} offline devices`
    : "";

  const settingsGo = (label: string) => {
    if (label === "Policies" || label === "Webhooks & alerts" || label === "Backups" || label === "Tenants") navigate("security-policies");
    else if (label === "Devices") navigate("devices");
    else if (label === "Users") { goLiveSection("users"); onNavigate?.(); }
  };

  /** Navigate into the live workspace section (UX-13/UX-16). Goes through
      the store's setCurrentView so the UX-31 navigation guard applies. */
  function goLiveSection(section: string) {
    setCurrentView("live", { extra: { section } });
    // pushState alone does not fire hashchange; force listeners (App
    // breadcrumb, LiveWorkspace) to sync.
    window.dispatchEvent(new Event("hashchange"));
  }

  return <nav aria-label="Main navigation" className="product-sidebar flex h-full w-full shrink-0 flex-col border-r lg:w-56">
    <div className="flex h-14 shrink-0 items-center px-4">
      <Brand />
    </div>
    <div className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
      {navGroupOrder.map((group) => {
        const items = navigationItems.filter((item) => item.group === group && !item.nestedUnder);
        if (!items.length) return null;
        return <div key={group}>
          <p className="product-kicker mb-2 px-3">{group}</p>
          <ul className="space-y-1">
            {items.map((item) => {
              const Icon = item.icon;
              const nested = navigationItems.filter((child) => child.nestedUnder === item.id);
              const selected = currentView === item.id || nested.some((child) => child.id === currentView);
              return <li key={item.id}>
                <button type="button" onClick={() => navigate(item.id)} aria-current={currentView === item.id ? "page" : undefined}
                  aria-label={fullViewAriaLabel(item.label, badgeTextFor(item.id))}
                  className="product-nav-link">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.id === "human-approvals" && pending > 0 && (
                    <span className="text-xs tabular-nums text-amber-200" aria-label={`${pending} pending`}>{pending}</span>
                  )}
                  {item.id === "task-queue-and-vision" && failedTasks > 0 && (
                    <span className="text-xs tabular-nums text-rose-300" aria-label={`${failedTasks} failed tasks`}>{failedTasks}</span>
                  )}
                  {item.id === "devices" && offlineDevices > 0 && (
                    <span className="text-xs tabular-nums text-amber-200" aria-label={`${offlineDevices} offline devices`}>{offlineDevices}</span>
                  )}
                </button>
                {selected && nested.length > 0 && (
                  <ul className="mt-1 space-y-1 border-l border-[color:var(--product-line)] ms-4 ps-2">
                    {nested.map((child) => {
                      const ChildIcon = child.icon;
                      return <li key={child.id}>
                        <button type="button" onClick={() => navigate(child.id)}
                          aria-current={currentView === child.id ? "page" : undefined}
                          aria-label={fullViewAriaLabel(child.label, badgeTextFor(child.id))}
                          className="product-nav-link text-sm!">
                          <ChildIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="flex-1 text-left">{child.label}</span>
                        </button>
                      </li>;
                    })}
                  </ul>
                )}
              </li>;
            })}
          </ul>
        </div>;
      })}
      <div>
        <p className="product-kicker mb-2 px-3">Settings</p>
        <ul className="space-y-1">
          {SETTINGS_LINKS.map((item) => (
            <li key={item.label}>
              <button type="button" onClick={() => settingsGo(item.label)} title={item.title}
                aria-label={DUPLICATE_SETTINGS_LABELS.has(item.label) ? `${item.label} — Settings` : undefined}
                className="product-nav-link">
                <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
    <div className="border-t border-[color:var(--product-line)] p-3 space-y-1">
      {/* Live/demo switch (UX-39): from Live home, go to the demo workspace;
          from anywhere else, go back to Live home. */}
      <button type="button"
        onClick={() => (onLive ? navigate("overview") : navigate("live"))}
        className="product-nav-link text-[color:var(--product-status-online)]!">
        <Server className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">{onLive ? "View demo workspace" : "Back to live home"}</span>
      </button>
      <a className="product-nav-link" href="https://github.com/jacxishipping/ai-bridge#readme" target="_blank" rel="noreferrer">
        <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Docs</span>
        <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
      </a>
      {/* UX-25: in-app glossary, next to Docs. */}
      <button type="button" onClick={() => setGlossaryOpen(true)} className="product-nav-link">
        <BookMarked className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Glossary</span>
      </button>
      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
      {isAuth ? (
        <button
          type="button"
          onClick={async () => {
            try { await api.logout(); } catch {}
            clearCredentials();
            navigate("login");
          }}
          className="product-nav-link text-[color:var(--product-text-dim)]!"
        >
          <span className="flex-1 text-left">Sign Out</span>
        </button>
      ) : (
        <button type="button" onClick={() => navigate("login")} className="product-nav-link">
          Connect to server<ArrowUpRight className="ms-auto h-4 w-4" aria-hidden="true" /></button>
      )}
    </div>
  </nav>;
};
