import {
  LayoutDashboard, Server, Cpu, ListChecks, MonitorPlay, Terminal, Workflow,
  Zap, Bot, ShieldCheck, Lock, ScrollText, Network, Activity,
} from "lucide-react";
import type { ViewId } from "../types/dashboard";

export type NavGroup = "Overview" | "Fleet" | "Execute" | "Govern" | "Integrate";

export const navigationItems = [
  // Canonical labels (UX-15/UX-39): one label per destination, used in the
  // sidebar, page title, breadcrumb, and palette. `aliases` are extra
  // palette search terms only (the older/longer names users may type).
  { id: "live", label: "Live home", group: "Overview", icon: Server, aliases: ["Control plane", "Home"] },
  { id: "overview", label: "Fleet overview", group: "Overview", icon: LayoutDashboard },
  { id: "devices", label: "Devices", group: "Fleet", icon: Server },
  { id: "device-360-system", label: "Device details", group: "Fleet", icon: Cpu, nestedUnder: "devices" },
  { id: "fleet-operations", label: "Fleet operations", group: "Fleet", icon: Zap },
  { id: "task-queue-and-vision", label: "Tasks", group: "Execute", icon: ListChecks, aliases: ["Task Queue & Vision", "Tasks & vision"] },
  { id: "live-desktop-studio", label: "Desktop", group: "Execute", icon: MonitorPlay, aliases: ["Remote desktop", "Live desktop"] },
  { id: "interactive-terminal", label: "Terminal", group: "Execute", icon: Terminal },
  { id: "autonomous-workflows", label: "Workflows", group: "Execute", icon: Workflow },
  { id: "human-approvals", label: "Approvals", group: "Govern", icon: ShieldCheck, aliases: ["Human approvals"] },
  { id: "security-policies", label: "Policies", group: "Govern", icon: Lock, aliases: ["Security policies"] },
  { id: "audit-trail", label: "Audit log", group: "Govern", icon: ScrollText, aliases: ["Audit trail"] },
  { id: "ai-api-and-agents", label: "AI providers", group: "Integrate", icon: Bot, aliases: ["AI providers & agents"] },
  { id: "mcp-and-oauth", label: "Connections", group: "Integrate", icon: Network, aliases: ["MCP & OAuth"] },
  { id: "diagnostics-and-logs", label: "Logs", group: "Integrate", icon: Activity, aliases: ["Diagnostics & logs"] },
] satisfies {
  id: ViewId;
  label: string;
  group: NavGroup;
  icon: typeof Server;
  nestedUnder?: ViewId;
  aliases?: string[];
}[];

export const navGroupOrder: NavGroup[] = ["Overview", "Fleet", "Execute", "Govern", "Integrate"];
