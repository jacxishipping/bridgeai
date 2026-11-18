/**
 * AI Bridge Enterprise Dashboard — Root Application
 * Mounts AppShell with active view routing connected to dashboardStore.
 * Strict JXUI Primitives & Lucide Icons. ZERO inline styles.
 */

import React, { useEffect, useRef, useState } from "react";
import { AppShell } from "./shell/AppShell";
import { NoticeStack } from "./components/NoticeStack";
import { useDashboardStore } from "./state/dashboardStore";
import { readRoute, type LiveSection, type LiveTab } from "./state/navigation";
import { pushNotice } from "./state/notices";
import type { ViewId } from "./types/dashboard";

// Import all 15 operational screen views
import { LoginView } from "./views/LoginView";
import { OverviewView } from "./views/OverviewView";
import { DevicesView } from "./views/DevicesView";
import { Device360View } from "./views/Device360View";
import { TaskQueueVisionView } from "./views/TaskQueueVisionView";
import { LiveDesktopView } from "./views/LiveDesktopView";
import { TerminalView } from "./views/TerminalView";
import { WorkflowsView } from "./views/WorkflowsView";
import { FleetOperationsView } from "./views/FleetOperationsView";
import { AiApiHubView } from "./views/AiApiHubView";
import { HumanApprovalsView } from "./views/HumanApprovalsView";
import { SecurityPoliciesView } from "./views/SecurityPoliciesView";
import { AuditTrailView } from "./views/AuditTrailView";
import { ConnectionsView } from "./views/ConnectionsView";
import { DiagnosticsLogsView } from "./views/DiagnosticsLogsView";
import { LiveControlView } from "./views/LiveControlView";

export interface ViewMetadata {
  title: string;
  domain: string;
  breadcrumbs: string[];
}

// Canonical labels (UX-15): the title is the sidebar label for the same
// destination, so nav, title, breadcrumb, and palette agree.
const VIEWS_WITH_OWN_HEADER: ViewId[] = [
  "live",
  "overview",
  "devices",
  "device-360-system",
  // These views render their own <header><h1> (LiveDesktopView, TerminalView,
  // HumanApprovalsView, ConnectionsView); without this entry App.tsx would
  // render a second shell h1 above it (duplicate-h1 a11y defect, caught by
  // the Playwright layout tests).
  "live-desktop-studio",
  "interactive-terminal",
  "human-approvals",
  "mcp-and-oauth",
  // UX-36: these views gained their own <h1> in the UX remediation
  // (TaskQueueVisionView, FleetOperationsView, AiApiHubView,
  // DiagnosticsLogsView); without an entry here the shell would render a
  // second h1 above them.
  "task-queue-and-vision",
  "fleet-operations",
  "ai-api-and-agents",
  "diagnostics-and-logs",
];

/** Live-workspace section labels for the #/live breadcrumb (UX-16). */
const LIVE_SECTION_LABELS: Record<LiveSection, string> = {
  devices: "Devices", tasks: "Tasks", approvals: "Approvals", notifications: "Notifications",
  audit: "Audit", policies: "Policies", connections: "Connections", logs: "Logs", users: "Users",
};
const LIVE_TAB_LABELS: Record<LiveTab, string> = {
  details: "Details", tasks: "Tasks", terminal: "Terminal", desktop: "Desktop",
};

export const App: React.FC = () => {
  const currentView = useDashboardStore((s) => s.currentView);
  const devices = useDashboardStore((s) => s.devices);
  const selectedDeviceId = useDashboardStore((s) => s.selectedDeviceId);
  // Live section/tab from the hash, kept in sync on hashchange/popstate so
  // the #/live breadcrumb reflects the live section the user is in (UX-16).
  // LiveWorkspace dispatches a synthetic hashchange after its pushState
  // navigations, so section clicks update this too.
  const [liveRoute, setLiveRoute] = useState(() => readRoute());
  useEffect(() => {
    const sync = () => setLiveRoute(readRoute());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // A stale/unknown device id never falls back to the first fleet device
  // (UX-27): the breadcrumb names it "Unknown device" instead.
  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);
  const selectedHostname = selectedDevice?.hostname || "Unknown device";

  // An unrecognised hash resolves to login (navigation.ts); say so briefly
  // on the login landing instead of looking like a logged-out session (UX-13).
  const lastBadHash = useRef("");
  useEffect(() => {
    if (currentView !== "login") return;
    const hash = window.location.hash;
    if (readRoute().unknownHash && lastBadHash.current !== hash) {
      lastBadHash.current = hash;
      pushNotice({
        tone: "warning",
        title: "That page doesn't exist",
        message: "The link you followed isn't a known page, so you were taken to Sign in instead.",
      });
    }
  }, [currentView]);

  // View titles and navigation breadcrumbs metadata for all 15 routes
  const liveBreadcrumbs = ["AI Bridge", "Live home"];
  if (liveRoute.section) liveBreadcrumbs.push(LIVE_SECTION_LABELS[liveRoute.section]);
  if (liveRoute.device && liveRoute.tab && liveRoute.tab !== "details") liveBreadcrumbs.push(LIVE_TAB_LABELS[liveRoute.tab]);
  const viewMeta: Record<ViewId, ViewMetadata> = {
    live: {
      title: "Live home",
      domain: "Live",
      breadcrumbs: liveBreadcrumbs,
    },
    overview: {
      title: "Fleet overview",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Fleet overview"],
    },
    devices: {
      title: "Devices",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Devices"],
    },
    "device-360-system": {
      title: "Device details",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Device details", selectedHostname],
    },
    "task-queue-and-vision": {
      title: "Tasks",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Tasks"],
    },
    "live-desktop-studio": {
      title: "Desktop",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Desktop"],
    },
    "interactive-terminal": {
      title: "Terminal",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Terminal"],
    },
    "autonomous-workflows": {
      title: "Workflows",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Workflows"],
    },
    "fleet-operations": {
      title: "Fleet operations",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "Fleet operations"],
    },
    "ai-api-and-agents": {
      title: "AI providers",
      domain: "Operations Domain",
      breadcrumbs: ["AI Bridge", "Operations", "AI providers"],
    },
    "human-approvals": {
      title: "Approvals",
      domain: "Governance Domain",
      breadcrumbs: ["AI Bridge", "Governance", "Approvals"],
    },
    "security-policies": {
      title: "Policies",
      domain: "Governance Domain",
      breadcrumbs: ["AI Bridge", "Governance", "Policies"],
    },
    "audit-trail": {
      title: "Audit log",
      domain: "Governance Domain",
      breadcrumbs: ["AI Bridge", "Governance", "Audit log"],
    },
    "mcp-and-oauth": {
      title: "Connections",
      domain: "Governance Domain",
      breadcrumbs: ["AI Bridge", "Governance", "Connections"],
    },
    "diagnostics-and-logs": {
      title: "Logs",
      domain: "Governance Domain",
      breadcrumbs: ["AI Bridge", "Governance", "Logs"],
    },
    login: {
      title: "Sign in",
      domain: "Authentication",
      breadcrumbs: ["AI Bridge", "Sign in"],
    },
  };

  const currentMeta = viewMeta[currentView] || viewMeta.overview;
  useEffect(() => {
    document.title = `${currentMeta.breadcrumbs[currentMeta.breadcrumbs.length - 1]} · AI Bridge${currentView !== "live" && currentView !== "login" ? " · Demo" : ""}`;
  }, [currentView, currentMeta]);

  const renderActiveView = () => {
    switch (currentView) {
      case "login":
        return <LoginView />;
      case "live":
        return <LiveControlView />;
      case "overview":
        return <OverviewView />;
      case "devices":
        return <DevicesView />;
      case "device-360-system":
        return <Device360View />;
      case "task-queue-and-vision":
        return <TaskQueueVisionView />;
      case "live-desktop-studio":
        return <LiveDesktopView />;
      case "interactive-terminal":
        return <TerminalView />;
      case "autonomous-workflows":
        return <WorkflowsView />;
      case "fleet-operations":
        return <FleetOperationsView />;
      case "ai-api-and-agents":
        return <AiApiHubView />;
      case "human-approvals":
        return <HumanApprovalsView />;
      case "security-policies":
        return <SecurityPoliciesView />;
      case "audit-trail":
        return <AuditTrailView />;
      case "mcp-and-oauth":
        return <ConnectionsView />;
      case "diagnostics-and-logs":
        return <DiagnosticsLogsView />;
      default:
        return <OverviewView />;
    }
  };

  // If current view is login, render full Zero-Trust Login Console
  // (login stays outside AppShell; every other view, including #/live,
  // renders inside it so the sidebar, palette, and TopHeader are always
  // available — UX-02).
  if (currentView === "login") {
    return (<><NoticeStack /><LoginView /></>);
  }

  return (
    <><NoticeStack />
    <AppShell currentView={currentView} viewMeta={currentMeta} showHeader={!VIEWS_WITH_OWN_HEADER.includes(currentView)}>
      <div className="w-full">
        {renderActiveView()}
      </div>
    </AppShell>
    </>
  );
};

export default App;
