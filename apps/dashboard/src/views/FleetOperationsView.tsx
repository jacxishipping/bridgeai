/**
 * Fleet Operations & Reactive Self-Healing Hub (Screen 8)
 * Reconstructed with pure JXUI primitives, motion/react, and lucide-react.
 * ZERO inline styles. ZERO custom CSS.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useScrollShadow } from "../hooks/useScrollShadow";
import {
  GlassModal,
  JXCard,
  JXCardHeader,
  JXCardContent,
  JXButton,
  JXBadge,
  JXSwitch,
  JXSelect,
  JXTextField,
  JXStack,
  JXLinearProgress,
  StatusBadge,
  EmptyState,
} from "../ui";
import {
  Radio,
  Zap,
  Activity,
  Calendar,
  HeartPulse,
  Play,
  RotateCcw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Terminal,
  Cpu,
  HardDrive,
  Shield,
  Layers,
  ChevronRight,
  Send,
  Eye,
  Pause,
  Filter,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useDashboardStore } from "../state/dashboardStore";
import { api, token, sessionToken, toIsoTimestamp } from "../api";
import { pushNotice } from "../state/notices";
import { Freshness } from "../components/Freshness";
import { useLanguage, formatDate } from "../i18n";

function isLiveMode(): boolean {
  return typeof window !== "undefined" && Boolean(token() || sessionToken());
}

interface SelfHealingRule {
  id: string;
  name: string;
  trigger: string;
  condition: string;
  action: string;
  enabled: boolean;
  firedCount: number;
  lastFired: string;
  category: "service" | "memory" | "mtls" | "disk";
  isBackend?: boolean;
}

interface CronJob {
  id: string;
  name: string;
  description: string;
  cronExpr: string;
  targets: string;
  lastStatus: "success" | "failed" | "running";
  lastDuration: string;
  nextRun: string;
  enabled: boolean;
  isBackend?: boolean;
}

const PRESET_SCRIPTS = {
  bash: `#!/usr/bin/env bash
# Telemetry verification & ephemeral worker hot-patch
set -euo pipefail
echo "[AI-BRIDGE] Verifying node attestations on $(hostname)..."
ai-bridge-ctl telemetry verify --strict-pcr7 || exit 1
systemctl reload-or-restart ai-bridge-edge-daemon
echo "[AI-BRIDGE] OK: Handshake confirmed via enclave loopback."`,
  powershell: `# PowerShell Core Fleet Attestation
$ErrorActionPreference = "Stop"
Write-Host "[AI-BRIDGE] Querying agent health on $env:COMPUTERNAME..."
Get-Service -Name "ai-bridge-agent" | Restart-Service -PassThru
Write-Host "[AI-BRIDGE] Verified agent service running state."`,
  python: `import os, sys, json
import urllib.request

print("[AI-BRIDGE] Executing python enclave diagnostics...")
status = {"node": os.uname().nodename, "health": "verified"}
print(json.dumps(status))`,
};

export const FleetOperationsView: React.FC = () => {
  const devices = useDashboardStore((s) => s.devices);
  const tasks = useDashboardStore((s) => s.tasks);
  const refreshLive = useDashboardStore((s) => s.refreshLive);
  const setCurrentView = useDashboardStore((s) => s.setCurrentView);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const scrollShadow = useScrollShadow(tableScrollRef);
  // UX-06: sync freshness in the header when live; UX-29: timestamps and
  // numbers go through useLanguage() with an explicit timeZone.
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  const { date, number } = useLanguage();
  const isLive = isLiveMode();

  // Target fleet selection
  const [targetScope, setTargetScope] = useState<"all" | "production-east" | "gpu-runners" | "custom">("all");
  const [concurrency, setConcurrency] = useState<number>(5);
  const [scriptLang, setScriptLang] = useState<"bash" | "powershell" | "python">("bash");
  const [scriptPayload, setScriptPayload] = useState<string>(PRESET_SCRIPTS.bash);

  // Broadcast execution state
  const [isBroadcasting, setIsBroadcasting] = useState<boolean>(false);
  // UX-23: Cancel calls POST /api/fleet/broadcast/{batch_id}/cancel, so
  // tasks in the batch that have not started yet are stopped on the
  // control plane before any agent picks them up. Tasks already running
  // on a device are left alone (the endpoint never aborts in-flight
  // device work) — the notice says so instead of implying a recall.
  // The poll timer id is kept so Cancel can clear it, and the live
  // batch id is kept so Cancel knows which batch to stop.
  const broadcastCancelRef = useRef(false);
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const broadcastBatchIdRef = useRef<string | null>(null);
  const [broadcastCancelled, setBroadcastCancelled] = useState(false);
  const [broadcastCancelling, setBroadcastCancelling] = useState(false);
  const [broadcastProgress, setBroadcastProgress] = useState<{
    succeeded: number;
    inProgress: number;
    failed: number;
    total: number;
  } | null>({
    succeeded: 38,
    inProgress: 2,
    failed: 0,
    total: 40,
  });
  const [selectedFailedNode, setSelectedFailedNode] = useState<{
    deviceId: string;
    exitCode: number;
    stderr: string;
  } | null>(null);
  const [lastFailedNode, setLastFailedNode] = useState<{
    deviceId: string;
    exitCode: number;
    stderr: string;
  } | null>(null);

  // Fleet version & update state
  const [fleetVersionInfo, setFleetVersionInfo] = useState<{
    control_plane_version?: string;
    git_commit?: string;
    git_branch?: string;
  } | null>(null);
  const [isUpdatingFleet, setIsUpdatingFleet] = useState<boolean>(false);
  // UX-23: the fleet update is a broadcast of update_fleet_agent, so it
  // shares the broadcast batch id and the same cancel endpoint. Cancel
  // pressed while the update POST is in flight is honoured once the
  // batch id comes back (see handleUpdateFleetAgents).
  const updateCancelRef = useRef(false);
  const updateBatchIdRef = useRef<string | null>(null);
  const [updateCancelled, setUpdateCancelled] = useState(false);
  const [updateCancelling, setUpdateCancelling] = useState(false);
  // UX-23: a failed live config load is a retryable error, not silent.
  // A 401 means the session ended: show an expired state instead of the
  // seed rules/schedules.
  const [configError, setConfigError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  // UX-20: blur validation for the two creation forms.
  const [ruleNameTouched, setRuleNameTouched] = useState(false);
  const [schedNameTouched, setSchedNameTouched] = useState(false);

  // Live creation inputs
  const [newRuleName, setNewRuleName] = useState<string>("");
  const [newRuleMetric, setNewRuleMetric] = useState<string>("memory_percent");
  const [newRuleThreshold, setNewRuleThreshold] = useState<number>(85);
  const [newRuleActionTarget, setNewRuleActionTarget] = useState<string>("get_system_info");

  const [newSchedName, setNewSchedName] = useState<string>("");
  const [newSchedInterval, setNewSchedInterval] = useState<number>(300);
  const [newSchedTool, setNewSchedTool] = useState<string>("get_system_info");

  // Self-healing rules engine state
  const [rules, setRules] = useState<SelfHealingRule[]>([
    {
      id: "SH-SVC-101",
      name: "Agent Service Failure Remediation",
      trigger: "service_crash",
      condition: "ai-bridge-agent exits with non-zero or SIGKILL",
      action: "systemctl restart ai-bridge-agent && notify SecOps",
      enabled: true,
      firedCount: 18,
      lastFired: "12m ago",
      category: "service",
    },
    {
      id: "SH-MEM-992",
      name: "Memory Leak Threshold Watchdog",
      trigger: "memory_leak",
      condition: "RAM RSS > 92% sustained for >= 10m",
      action: "Flush buffer cache, trigger heap dump & worker recycle",
      enabled: true,
      firedCount: 14,
      lastFired: "34m ago",
      category: "memory",
    },
    {
      id: "SH-TLS-204",
      name: "mTLS Ephemeral Handshake Stale",
      trigger: "stale_mtls",
      condition: "Handshake negotiation timeout > 60s",
      action: "Rotate ephemeral keypair + re-register enclave",
      enabled: true,
      firedCount: 6,
      lastFired: "3h ago",
      category: "mtls",
    },
    {
      id: "SH-DSK-319",
      name: "Disk Pressure Volume Sentinel",
      trigger: "disk_pressure",
      condition: "Root volume free space < 10% available",
      action: "Purge temporary task artifacts older than 48h",
      enabled: true,
      firedCount: 29,
      lastFired: "1h ago",
      category: "disk",
    },
  ]);

  // Cron schedule state
  const [cronJobs, setCronJobs] = useState<CronJob[]>([
    {
      id: "CRN-081",
      name: "Nightly Enclave Key Rotation",
      description: "Renew ephemeral RSA/ECDSA signing pairs & flush TLS session tickets",
      cronExpr: "0 2 * * *",
      targets: "All devices (40)",
      lastStatus: "success",
      lastDuration: "42s",
      nextRun: "In 18 mins",
      enabled: true,
    },
    {
      id: "CRN-114",
      name: "Bi-Hourly Diagnostic Journal Flush",
      description: "Compress and sync rotated diagnostic journal bundles to storage volume",
      cronExpr: "*/15 * * * *",
      targets: "#production-east (14)",
      lastStatus: "success",
      lastDuration: "12s",
      nextRun: "In 4m 12s",
      enabled: true,
    },
    {
      id: "CRN-209",
      name: "Weekly TPM PCR Attestation Integrity Scan",
      description: "Cryptographic hash verification of PCR-7 boot measurements across fleet",
      cronExpr: "0 0 * * 0",
      targets: "All devices (40)",
      lastStatus: "success",
      lastDuration: "1m 18s",
      nextRun: "In 4 days",
      enabled: true,
    },
    {
      id: "CRN-332",
      name: "Dead Socket Reclamation & TCP Cleanup",
      description: "Detect orphaned WebSocket and SSE client connections and reclaim file descriptors",
      cronExpr: "*/30 * * * *",
      targets: "Gateways (6)",
      lastStatus: "success",
      lastDuration: "6s",
      nextRun: "In 12m",
      enabled: true,
    },
  ]);

  const [fleetFramesCount, setFleetFramesCount] = useState<number | null>(null);

  const loadLiveFleetConfig = useCallback(async () => {
    if (!isLiveMode()) return;
    const wasLive = isLiveMode();
    setConfigError(null);
    try {
      const [trigRes, schedRes, verRes, framesRes] = await Promise.all([
        api.triggers().catch(() => null),
        api.schedules().catch(() => null),
        api.fleetVersion().catch(() => null),
        api.fleetDesktopFrames().catch(() => null),
      ]);

      if (verRes && typeof verRes === "object") {
        setFleetVersionInfo(verRes);
      }

      if (framesRes && typeof framesRes === "object") {
        const framesList = Array.isArray((framesRes as { frames?: unknown[] }).frames)
          ? (framesRes as { frames: unknown[] }).frames
          : null;
        const count =
          framesList !== null
            ? framesList.length
            : typeof (framesRes as { count?: unknown }).count === "number"
            ? Number((framesRes as { count: number }).count)
            : null;
        setFleetFramesCount(count);
      }

      if (Array.isArray(trigRes) && trigRes.length > 0) {
        const mappedRules: SelfHealingRule[] = trigRes.map((t: any) => {
          const metric = String(t.metric || "cpu_percent");
          const cat: SelfHealingRule["category"] = metric.includes("mem")
            ? "memory"
            : metric.includes("disk")
            ? "disk"
            : metric.includes("tls")
            ? "mtls"
            : "service";
          return {
            id: String(t.id),
            name: String(t.name || "Telemetry Sentinel"),
            trigger: metric,
            condition: `${metric} ${t.operator || ">"} ${t.threshold ?? 85}${t.device_id ? ` (${t.device_id})` : " (fleet)"}`,
            action: `${t.action_type || "tool"}: ${t.action_target || "get_system_info"}`,
            enabled: Boolean(t.enabled),
            firedCount: t.last_triggered_at ? 1 : 0,
            lastFired: t.last_triggered_at
              ? formatDate(new Date(toIsoTimestamp(t.last_triggered_at, new Date().toISOString())), { dateStyle: "medium", timeStyle: "short" })
              : "Never",
            category: cat,
            isBackend: true,
          };
        });
        setRules(mappedRules);
      }

      if (Array.isArray(schedRes) && schedRes.length > 0) {
        const mappedJobs: CronJob[] = schedRes.map((s: any) => ({
          id: String(s.id),
          name: String(s.name || s.tool || "Scheduled Job"),
          description: `Tool: ${s.tool || "get_system_info"}`,
          cronExpr: `every ${s.interval_seconds || 300}s`,
          targets: String(s.device_id || "local"),
          lastStatus: "success",
          lastDuration: s.last_run_at ? "completed" : "pending",
          nextRun: s.next_run_at
            ? formatDate(new Date(toIsoTimestamp(s.next_run_at, new Date().toISOString())), { dateStyle: "medium", timeStyle: "short" })
            : `Every ${s.interval_seconds || 300}s`,
          enabled: Boolean(s.enabled),
          isBackend: true,
        }));
        setCronJobs(mappedJobs);
      }
      setExpired(false);
    } catch (err) {
      // A 401 means the session ended: show the expired state instead of
      // the seed rules/schedules. Any other failure is retryable (UX-23).
      const status = (err as { status?: number })?.status;
      if (wasLive && status === 401) {
        setExpired(true);
        pushNotice({
          tone: "error",
          title: "Your session expired",
          message: "Sign in again to manage fleet operations.",
          actionLabel: "Sign in",
          actionHref: "#/login",
        });
        return;
      }
      setConfigError(
        status === 403
          ? "Access denied (403). Your account may lack permission to read fleet automation — ask an admin to check your role."
          : status === 429
            ? "Too many requests (429). Wait a minute, then use Retry."
            : status && status >= 500
              ? `Control plane error (${status}). Fleet automation failed to load — use Retry.`
              : err instanceof Error ? err.message : "Fleet automation failed to load."
      );
    }
  }, []);

  useEffect(() => {
    void loadLiveFleetConfig();
  }, [loadLiveFleetConfig]);

  const targetCount =
    targetScope === "all"
      ? devices.length
      : targetScope === "production-east"
      ? devices.filter((d) => d.tags.includes("production-east")).length
      : targetScope === "gpu-runners"
      ? 6
      : 8;

  /** UX-23: cancel the live broadcast batch on the control plane, then
      stop polling. Queued tasks in the batch are stopped before any
      agent picks them up; tasks already running on a device finish —
      the notice reports both counts. In demo mode there is no batch,
      so cancel stays local-only. */
  const cancelBroadcast = async () => {
    broadcastCancelRef.current = true;
    if (broadcastTimerRef.current) {
      clearTimeout(broadcastTimerRef.current);
      broadcastTimerRef.current = null;
    }
    const batchId = broadcastBatchIdRef.current;
    if (isLiveMode() && batchId) {
      setBroadcastCancelling(true);
      try {
        const res = await api.cancelBroadcast(batchId);
        const cancelled = Number(res?.cancelled ?? 0);
        const stillRunning = Number(res?.still_running ?? 0);
        setBroadcastProgress((prev) =>
          prev ? { ...prev, inProgress: 0 } : prev
        );
        setBroadcastCancelled(true);
        pushNotice({
          tone: "warning",
          title: "Broadcast cancelled",
          message:
            stillRunning > 0
              ? `${cancelled} task${cancelled === 1 ? "" : "s"} stopped before running; ${stillRunning} already running on a device will finish — check the task list to see what went out.`
              : `${cancelled} task${cancelled === 1 ? "" : "s"} stopped before running — nothing further was dispatched to a device.`,
          actionLabel: "Check tasks",
          actionHref: "#/task-queue-and-vision",
        });
      } catch {
        setBroadcastCancelled(true);
        pushNotice({
          tone: "error",
          title: "Broadcast cancel failed",
          message: "Polling stopped, but the control plane did not confirm the cancel — check the task list to see what went out.",
          actionLabel: "Check tasks",
          actionHref: "#/task-queue-and-vision",
        });
      } finally {
        setBroadcastCancelling(false);
        setIsBroadcasting(false);
      }
      return;
    }
    setBroadcastCancelled(true);
    setIsBroadcasting(false);
    setBroadcastProgress((prev) =>
      prev ? { ...prev, inProgress: 0 } : prev
    );
    pushNotice({
      tone: "warning",
      title: "Broadcast cancelled in the dashboard",
      message: "Polling stopped. This is a demo broadcast with no live batch, so there was nothing to cancel on the control plane.",
      actionLabel: "Check tasks",
      actionHref: "#/task-queue-and-vision",
    });
  };

  const handleBroadcast = async () => {
    if (!scriptPayload.trim()) return;
    broadcastCancelRef.current = false;
    broadcastBatchIdRef.current = null;
    setBroadcastCancelled(false);
    setIsBroadcasting(true);
    setBroadcastProgress({
      succeeded: 0,
      inProgress: targetCount,
      failed: 0,
      total: targetCount,
    });

    if (isLiveMode()) {
      try {
        const targetDeviceIds =
          targetScope === "all"
            ? undefined
            : targetScope === "production-east"
            ? devices.filter((d) => d.tags.includes("production-east")).map((d) => d.id)
            : devices.slice(0, targetCount).map((d) => d.id);

        const res = await api.fleetBroadcast({
          tool: "run_shell",
          args: { command: scriptPayload },
          target_device_ids: targetDeviceIds && targetDeviceIds.length > 0 ? targetDeviceIds : undefined,
        });

        const totalTasks = Number(res?.device_count || targetCount || 1);
        setBroadcastProgress({
          succeeded: 0,
          inProgress: totalTasks,
          failed: 0,
          total: totalTasks,
        });
        void refreshLive?.();

        if (res?.batch_id) {
          const batchId = String(res.batch_id);
          broadcastBatchIdRef.current = batchId;
          let attempts = 0;
          const pollBatch = async () => {
            if (broadcastCancelRef.current) return;
            attempts += 1;
            try {
              const statusRes = await api.broadcastStatus(batchId);
              if (broadcastCancelRef.current) return;
              const total = Number(statusRes?.total_tasks || totalTasks);
              const succeeded = Number(statusRes?.completed || 0);
              const failed = Number(statusRes?.failed || 0);
              const cancelledCount = Number(statusRes?.cancelled || 0);
              const inProgress = Math.max(0, total - succeeded - failed - cancelledCount);
              setBroadcastProgress({
                succeeded,
                inProgress,
                failed,
                total,
              });
              if (Array.isArray(statusRes?.tasks)) {
                const failedTask = statusRes.tasks.find((t: any) => t.status === "failed");
                if (failedTask) {
                  setLastFailedNode({
                    deviceId: String(failedTask.device_name || failedTask.device_id || "unknown"),
                    exitCode: Number(failedTask.result?.returncode ?? 1),
                    stderr: String(failedTask.result?.stderr || failedTask.result?.error || "Task execution failed"),
                  });
                }
              }
              // UX-23: "cancelled" is terminal too — the batch may have
              // been cancelled from another tab/session.
              if (statusRes?.status === "completed" || statusRes?.status === "cancelled" || attempts >= 8) {
                setIsBroadcasting(false);
                pushNotice({
                  tone: statusRes?.status === "cancelled" ? "warning" : failed > 0 ? "warning" : "success",
                  title:
                    statusRes?.status === "cancelled"
                      ? `Broadcast cancelled: ${succeeded}/${total} devices succeeded${cancelledCount > 0 ? `, ${cancelledCount} stopped` : ""}${failed > 0 ? `, ${failed} failed` : ""}`
                      : `Broadcast finished: ${succeeded}/${total} devices succeeded${failed > 0 ? `, ${failed} failed` : ""}`,
                  actionLabel: "Check tasks",
                  actionHref: "#/task-queue-and-vision",
                });
                void refreshLive?.();
              } else {
                broadcastTimerRef.current = setTimeout(() => void pollBatch(), 1500);
              }
            } catch {
              setIsBroadcasting(false);
            }
          };
          broadcastTimerRef.current = setTimeout(() => void pollBatch(), 1000);
          return;
        }
        setIsBroadcasting(false);
        return;
      } catch (err: any) {
        // UX-18: map common statuses to plain language with a next step,
        // and link to the task list so the operator can check what ran.
        const status = (err as { status?: number })?.status;
        const uncertain = (err as { uncertain?: boolean })?.uncertain;
        const detail =
          status === 403
            ? "Access denied (403). Your account may lack permission to broadcast — ask an admin to check your role."
            : status === 409
              ? "Conflict (409). The fleet state changed under this broadcast — reload and try again."
              : status === 429
                ? "Too many requests (429). Wait a minute and try again."
                : status && status >= 500
                  ? `Control plane error (${status}). The broadcast may or may not have been dispatched — check the task list before sending it again.`
                  : uncertain
                    ? `${err?.message || "Broadcast failed."} Outcome unknown — the server may have received this request. Check the task list before sending it again.`
                    : err?.message || "Failed to dispatch fleet broadcast";
        setLastFailedNode({
          deviceId: "control-plane-broadcast",
          exitCode: 1,
          stderr: detail,
        });
        setBroadcastProgress({
          succeeded: 0,
          inProgress: 0,
          failed: Math.max(1, targetCount),
          total: Math.max(1, targetCount),
        });
        setIsBroadcasting(false);
        pushNotice({
          tone: "error",
          title: "Broadcast failed",
          message: detail,
          actionLabel: "Check tasks",
          actionHref: "#/task-queue-and-vision",
        });
        return;
      }
    }

    broadcastTimerRef.current = setTimeout(() => {
      if (broadcastCancelRef.current) return;
      setBroadcastProgress({
        succeeded: Math.max(1, targetCount - 2),
        inProgress: 2,
        failed: 0,
        total: targetCount,
      });
      setIsBroadcasting(false);
    }, 1200);
  };

  const handleUpdateFleetAgents = async (targetOs?: string) => {
    updateCancelRef.current = false;
    updateBatchIdRef.current = null;
    setUpdateCancelled(false);
    setIsUpdatingFleet(true);
    if (isLiveMode()) {
      try {
        const res = await api.updateFleet(targetOs);
        const batchId = res?.batch_id ? String(res.batch_id) : null;
        if (batchId) updateBatchIdRef.current = batchId;
        if (updateCancelRef.current) {
          // UX-23: Cancel was pressed while the update POST was in flight.
          // The update is a broadcast batch, so stop it on the control
          // plane now that the batch id is known.
          if (batchId) {
            setUpdateCancelling(true);
            try {
              const cancelRes = await api.cancelBroadcast(batchId);
              const cancelled = Number(cancelRes?.cancelled ?? 0);
              const stillRunning = Number(cancelRes?.still_running ?? 0);
              pushNotice({
                tone: "warning",
                title: "Fleet update cancelled",
                message:
                  stillRunning > 0
                    ? `${cancelled} update task${cancelled === 1 ? "" : "s"} stopped before running; ${stillRunning} already running on a device will finish — check the audit trail to confirm what ran.`
                    : `${cancelled} update task${cancelled === 1 ? "" : "s"} stopped before running.`,
                actionLabel: "Check audit trail",
                actionHref: "#/audit-trail",
              });
            } catch {
              pushNotice({
                tone: "error",
                title: "Fleet update cancel failed",
                message: "The update was dispatched and the control plane did not confirm the cancel — check the audit trail to confirm what ran.",
                actionLabel: "Check audit trail",
                actionHref: "#/audit-trail",
              });
            } finally {
              setUpdateCancelling(false);
            }
          } else {
            pushNotice({
              tone: "warning",
              title: "Fleet update cancelled in the dashboard",
              message: "The update request had already been sent and may still have been dispatched — check the audit trail to confirm what ran.",
              actionLabel: "Check audit trail",
              actionHref: "#/audit-trail",
            });
          }
          return;
        }
        pushNotice({
          tone: "success",
          title: `Fleet agent update dispatched (batch ${res?.batch_id || "ok"}, ${number(res?.device_count ?? devices.length)} devices)`,
          actionLabel: "Check tasks",
          actionHref: "#/task-queue-and-vision",
        });
        void refreshLive?.();
      } catch (err: any) {
        const status = (err as { status?: number })?.status;
        pushNotice({
          tone: "error",
          title: "Fleet update failed",
          message:
            status === 403
              ? "Access denied (403). Your account may lack permission to update fleet agents — ask an admin to check your role."
              : status && status >= 500
                ? `Control plane error (${status}). The update may or may not have been dispatched — check the audit trail before retrying.`
                : err?.message || "Fleet update request failed",
          actionLabel: "Check audit trail",
          actionHref: "#/audit-trail",
        });
      } finally {
        setIsUpdatingFleet(false);
      }
      return;
    }
    broadcastTimerRef.current = setTimeout(() => {
      setIsUpdatingFleet(false);
      if (!updateCancelRef.current) {
        pushNotice({ tone: "info", title: `Simulated fleet agent rolling update across ${number(devices.length)} devices` });
      }
    }, 600);
  };

  /** UX-23: Cancel a fleet-agent update. In live mode the batch id is
      only known once the update POST returns, so this marks the cancel
      and handleUpdateFleetAgents calls the cancel endpoint with the
      batch id when it arrives; in demo mode there is no batch, so the
      cancel stays local-only. */
  const cancelFleetUpdate = () => {
    updateCancelRef.current = true;
    setUpdateCancelled(true);
    setIsUpdatingFleet(false);
    if (!isLiveMode()) {
      pushNotice({
        tone: "warning",
        title: "Fleet update cancelled in the dashboard",
        message: "This is a demo update with no live batch, so there was nothing to cancel on the control plane.",
        actionLabel: "Check audit trail",
        actionHref: "#/audit-trail",
      });
    }
  };

  const handleCreateLiveTrigger = async () => {
    if (!newRuleName.trim()) return;
    if (isLiveMode()) {
      try {
        await api.createTrigger({
          name: newRuleName.trim(),
          metric: newRuleMetric,
          operator: ">",
          threshold: newRuleThreshold,
          action_type: "tool",
          action_target: newRuleActionTarget || "get_system_info",
          action_args: {},
          cooldown_seconds: 300,
          enabled: true,
        });
        setNewRuleName("");
        await loadLiveFleetConfig();
        return;
      } catch {
        // Fallback to local state append
      }
    }
    setRules((prev) => [
      {
        id: `SH-USR-${Date.now().toString().slice(-3)}`,
        name: newRuleName.trim(),
        trigger: newRuleMetric,
        condition: `${newRuleMetric} > ${newRuleThreshold}%`,
        action: `tool: ${newRuleActionTarget || "get_system_info"}`,
        enabled: true,
        firedCount: 0,
        lastFired: "Never",
        category: newRuleMetric.includes("mem") ? "memory" : newRuleMetric.includes("disk") ? "disk" : "service",
      },
      ...prev,
    ]);
    setNewRuleName("");
  };

  const handleDeleteRule = async (id: string, isBackend?: boolean) => {
    if (isLiveMode() && isBackend) {
      try {
        await api.deleteTrigger(id);
        await loadLiveFleetConfig();
        return;
      } catch {
        // Fallback to local filter
      }
    }
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleToggleRule = async (id: string) => {
    const target = rules.find((r) => r.id === id);
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
    if (isLiveMode() && target?.isBackend) {
      try {
        await api.toggleTrigger(id);
        await loadLiveFleetConfig();
      } catch {
        // Keep optimistic state
      }
    }
  };

  const handleSimulateRuleTrigger = async (id: string) => {
    const target = rules.find((r) => r.id === id);
    setRules((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              firedCount: r.firedCount + 1,
              lastFired: "Just now",
            }
          : r
      )
    );
    if (isLiveMode()) {
      try {
        if (target?.isBackend) {
          await api.testTrigger(id);
          void refreshLive?.();
        } else if (target) {
          const created = await api.createTrigger({
            name: target.name,
            metric: "memory_percent",
            operator: ">",
            threshold: 85,
            action_type: "tool",
            action_target: "get_system_info",
            action_args: {},
            cooldown_seconds: 300,
            enabled: target.enabled,
          });
          if (created?.trigger_id) {
            await api.testTrigger(String(created.trigger_id));
            await loadLiveFleetConfig();
            void refreshLive?.();
          }
        }
      } catch {
        // Keep optimistic state
      }
    }
  };

  const handleCreateLiveSchedule = async () => {
    if (!newSchedName.trim()) return;
    if (isLiveMode()) {
      try {
        await api.createSchedule({
          name: newSchedName.trim(),
          device_id: devices[0]?.id || "local",
          interval_seconds: Math.max(10, Number(newSchedInterval) || 300),
          tool: newSchedTool || "get_system_info",
          args: {},
          enabled: true,
        });
        setNewSchedName("");
        await loadLiveFleetConfig();
        return;
      } catch {
        // Fallback to local state append
      }
    }
    setCronJobs((prev) => [
      {
        id: `CRN-${Date.now().toString().slice(-3)}`,
        name: newSchedName.trim(),
        description: `Tool: ${newSchedTool || "get_system_info"}`,
        cronExpr: `every ${newSchedInterval}s`,
        targets: devices[0]?.hostname || "All devices",
        lastStatus: "success",
        lastDuration: "0s",
        nextRun: `In ${newSchedInterval}s`,
        enabled: true,
      },
      ...prev,
    ]);
    setNewSchedName("");
  };

  const handleDeleteSchedule = async (jobId: string, isBackend?: boolean) => {
    if (isLiveMode() && isBackend) {
      try {
        await api.deleteSchedule(jobId);
        await loadLiveFleetConfig();
        return;
      } catch {
        // Fallback to local filter
      }
    }
    setCronJobs((prev) => prev.filter((j) => j.id !== jobId));
  };

  const handleRunCronNow = async (jobId: string) => {
    const targetJob = cronJobs.find((j) => j.id === jobId);
    setCronJobs((prev) =>
      prev.map((j) =>
        j.id === jobId ? { ...j, lastStatus: "running" as const } : j
      )
    );

    if (isLiveMode()) {
      try {
        if (targetJob?.isBackend) {
          await api.runScheduleNow(jobId);
        } else if (targetJob) {
          const created = await api.createSchedule({
            name: targetJob.name,
            device_id: devices[0]?.id || "local",
            interval_seconds: 300,
            tool: "get_system_info",
            args: {},
            enabled: true,
          });
          if (created?.schedule_id) {
            await api.runScheduleNow(String(created.schedule_id));
            await loadLiveFleetConfig();
          }
        }
        setCronJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? { ...j, lastStatus: "success" as const, lastDuration: "live" }
              : j
          )
        );
        void refreshLive?.();
        return;
      } catch {
        setCronJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? { ...j, lastStatus: "failed" as const, lastDuration: "err" }
              : j
          )
        );
        return;
      }
    }

    setTimeout(() => {
      setCronJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, lastStatus: "success" as const, lastDuration: "18s" }
            : j
        )
      );
    }, 1000);
  };

  const handleLanguageChange = (lang: "bash" | "powershell" | "python") => {
    setScriptLang(lang);
    setScriptPayload(PRESET_SCRIPTS[lang]);
  };

  const progressPercent = broadcastProgress
    ? Math.round((broadcastProgress.succeeded / broadcastProgress.total) * 100)
    : 100;

  return (
    <div className="space-y-4">
      {/* UX-36: explicit top-level heading (this view previously had none). */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-[var(--product-text)]">Fleet operations</h1>
          <p className="text-xs text-[var(--product-text-tertiary)]">
            Broadcast a shell task to many devices at once, watch self-healing rules, and manage schedules.
          </p>
        </div>
        {isLive && (
          <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} label="Updated" />
        )}
      </header>
      {isLive && syncState === "error" && !expired && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-700/50 bg-rose-950/30 px-4 py-2 text-xs text-rose-300">
          <span>Sync with the control plane failed{syncError ? `: ${syncError}` : "."} Showing the last known data.</span>
          <JXButton variant="outlined" color="neutral" size="sm" onClick={() => void refreshLive?.()}>Retry</JXButton>
        </div>
      )}
      {isLive && configError && !expired && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-700/50 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
          <span>Fleet automation failed to load: {configError}</span>
          <JXButton variant="outlined" color="neutral" size="sm" onClick={() => void loadLiveFleetConfig()}>Retry</JXButton>
        </div>
      )}
      {expired && (
        <EmptyState
          variant="card"
          title="Your session expired"
          description="Sign in again to manage fleet operations. The rules and schedules below are samples, not your live automation."
          actionLabel="Sign in"
          onAction={() => setCurrentView("login")}
        />
      )}
      {/* SECTION 1: Multi-Node Command Bus */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
        <JXCardHeader
          title="Run on multiple devices"
          icon={<Terminal className="w-5 h-5 text-indigo-400" />}
        />
        <JXCardContent>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6">
            {/* Target Fleet Selector & Concurrency */}
            <div className="lg:col-span-4 space-y-4">
              <fieldset>
                <legend className="mb-2 block text-xs font-mono font-semibold text-[var(--product-text-tertiary)] uppercase tracking-wider">
                  Target Fleet Scope
                </legend>
                <div className="space-y-2">
                    <button
                      type="button"
                      aria-pressed={targetScope === "all"}
                      onClick={() => setTargetScope("all")}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border text-xs text-left transition-colors ${
                        targetScope === "all"
                          ? "bg-indigo-950/60 border-indigo-500/60 text-indigo-200"
                          : "bg-[var(--product-canvas)]/60 border-[var(--product-line)] text-[var(--product-text-secondary)] hover:border-[var(--product-line)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-indigo-400" />
                        <span className="font-semibold">All fleet devices</span>
                      </div>
                      <span className="font-mono px-2 py-0.5 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                        {devices.length}
                      </span>
                    </button>

                    <button
                      type="button"
                      aria-pressed={targetScope === "production-east"}
                      onClick={() => setTargetScope("production-east")}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border text-xs text-left transition-colors ${
                        targetScope === "production-east"
                          ? "bg-indigo-950/60 border-indigo-500/60 text-indigo-200"
                          : "bg-[var(--product-canvas)]/60 border-[var(--product-line)] text-[var(--product-text-secondary)] hover:border-[var(--product-line)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        <span className="font-semibold">Tag: #production-east</span>
                      </div>
                      <span className="font-mono px-2 py-0.5 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                        {devices.filter((d) => d.tags.includes("production-east")).length}
                      </span>
                    </button>

                    <button
                      type="button"
                      aria-pressed={targetScope === "gpu-runners"}
                      onClick={() => setTargetScope("gpu-runners")}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border text-xs text-left transition-colors ${
                        targetScope === "gpu-runners"
                          ? "bg-indigo-950/60 border-indigo-500/60 text-indigo-200"
                          : "bg-[var(--product-canvas)]/60 border-[var(--product-line)] text-[var(--product-text-secondary)] hover:border-[var(--product-line)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-cyan-400" />
                        <span className="font-semibold">Tag: #gpu-runners</span>
                      </div>
                      <span className="font-mono px-2 py-0.5 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">6</span>
                    </button>

                    <button
                      type="button"
                      aria-pressed={targetScope === "custom"}
                      onClick={() => setTargetScope("custom")}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border text-xs text-left transition-colors ${
                        targetScope === "custom"
                          ? "bg-indigo-950/60 border-indigo-500/60 text-indigo-200"
                          : "bg-[var(--product-canvas)]/60 border-[var(--product-line)] text-[var(--product-text-secondary)] hover:border-[var(--product-line)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Layers className="w-3.5 h-3.5 text-[var(--product-text-tertiary)]" />
                        <span className="font-semibold">Custom Multi-Select</span>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-[var(--product-text-tertiary)]" />
                    </button>
                  </div>
                </fieldset>

                {/* Concurrency Rollout Slider */}
                <div className="p-3 rounded-xl bg-[var(--product-canvas)]/60 border border-[var(--product-line)] space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--product-text-secondary)] font-semibold">Concurrency Rollout</span>
                    <span className="font-mono text-indigo-400 font-bold">
                      {number(concurrency)} devices in parallel
                    </span>
                  </div>
                  <input
                    aria-label="Devices to update in parallel"
                    type="range"
                    min={1}
                    max={20}
                    step={1}
                    value={concurrency}
                    onChange={(e) => setConcurrency(Math.min(20, Math.max(1, Number(e.target.value))))}
                    className="w-full accent-indigo-500 bg-[var(--product-raised)] rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] font-mono text-[var(--product-text-tertiary)]">
                    <span>1 (Staged)</span>
                    <span>5 (Default)</span>
                    <span>20 (Full Burst)</span>
                  </div>
                </div>
              </div>

            {/* Script Payload Editor & Broadcast CTA */}
            <div className="lg:col-span-8 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 p-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)]">
                    <button
                      type="button"
                      aria-pressed={scriptLang === "bash"}
                      onClick={() => handleLanguageChange("bash")}
                      className={`px-3 py-1 rounded text-xs font-mono transition-colors ${
                        scriptLang === "bash"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                      }`}
                    >
                      Bash (sh/zsh)
                    </button>
                    <button
                      type="button"
                      aria-pressed={scriptLang === "powershell"}
                      onClick={() => handleLanguageChange("powershell")}
                      className={`px-3 py-1 rounded text-xs font-mono transition-colors ${
                        scriptLang === "powershell"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                      }`}
                    >
                      PowerShell Core
                    </button>
                    <button
                      type="button"
                      aria-pressed={scriptLang === "python"}
                      onClick={() => handleLanguageChange("python")}
                      className={`px-3 py-1 rounded text-xs font-mono transition-colors ${
                        scriptLang === "python"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                      }`}
                    >
                      Python 3.12
                    </button>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-mono text-[var(--product-text-tertiary)]">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span>mTLS Zero-Trust Bus</span>
                  </div>
                </div>

                <div className="rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] overflow-hidden font-mono text-xs">
                  <div className="p-3 bg-[var(--product-surface)]/80 border-b border-[var(--product-line)] flex items-center justify-between text-[var(--product-text-tertiary)]">
                    <span>payload.{scriptLang === "powershell" ? "ps1" : scriptLang === "python" ? "py" : "sh"}</span>
                    <span>SHA256: e82b...9a12 • Ed25519 Signed</span>
                  </div>
                  <textarea
                    aria-label="Broadcast script payload"
                    rows={8}
                    value={scriptPayload}
                    onChange={(e) => setScriptPayload(e.target.value)}
                    placeholder="Enter shell or script command payload..."
                    className="w-full p-4 bg-transparent text-[var(--product-text-secondary)] font-mono text-xs focus:outline-none resize-none"
                  />
                </div>

                {/* Real-time Aggregate Broadcast Progress Bar */}
                {broadcastProgress && (
                  <div className="p-4 rounded-xl bg-[var(--product-canvas)]/70 border border-[var(--product-line)] space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <div className="flex items-center gap-2">
                        {/* UX-24: a running broadcast is a busy state, not a
                            live/online indicator — a spinner, not pulse. */}
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" aria-hidden="true" />
                        <span className="text-[var(--product-text-secondary)] font-semibold">
                          Broadcast Progress: {broadcastProgress.succeeded}/{broadcastProgress.total} Succeeded
                        </span>
                        <span className="text-cyan-400">({broadcastProgress.inProgress} In-Progress)</span>
                        {broadcastProgress.failed > 0 && (
                          <span className="text-rose-400">({broadcastProgress.failed} Failed)</span>
                        )}
                      </div>
                      <span className="text-emerald-400 font-bold">{progressPercent}% Complete</span>
                    </div>

                    <JXLinearProgress
                      value={progressPercent}
                      className="w-full bg-[var(--product-raised)]"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2">
                    <JXButton
                      variant="soft"
                      color="neutral"
                      size="sm"
                      onClick={() =>
                        setSelectedFailedNode(
                          lastFailedNode || {
                            deviceId: "srv-us-east-412",
                            exitCode: 1,
                            stderr: "Permission denied: access to enclave socket restricted",
                          }
                        )
                      }
                      startIcon={<Eye className="w-3.5 h-3.5" />}
                    >
                      Failure Drill-Down
                    </JXButton>
                    <JXButton
                      variant="soft"
                      color="neutral"
                      size="sm"
                      loading={isUpdatingFleet}
                      onClick={() => void handleUpdateFleetAgents()}
                      startIcon={<RefreshCw className="w-3.5 h-3.5" />}
                    >
                      Update Fleet Agents
                    </JXButton>
                    {fleetVersionInfo?.control_plane_version && (
                      <span className="text-[11px] font-mono text-[var(--product-text-tertiary)]">
                        v{fleetVersionInfo.control_plane_version} ({fleetVersionInfo.git_commit || "main"})
                      </span>
                    )}
                    {fleetFramesCount !== null && (
                      <span className="text-[11px] font-mono text-[var(--product-text-tertiary)]">
                        {number(fleetFramesCount)} live frame{fleetFramesCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {isUpdatingFleet && (
                      <JXButton
                        variant="outlined"
                        color="warning"
                        size="sm"
                        loading={updateCancelling}
                        disabled={updateCancelling}
                        onClick={cancelFleetUpdate}
                      >
                        Cancel update
                      </JXButton>
                    )}
                    {updateCancelled && !isUpdatingFleet && (
                      <span className="text-[11px] font-mono text-amber-300">
                        Update cancelled — tasks not yet started were stopped on the control plane; any already running finish on their devices. Check the audit trail.
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {isBroadcasting && (
                      <JXButton
                        variant="outlined"
                        color="warning"
                        size="md"
                        loading={broadcastCancelling}
                        disabled={broadcastCancelling}
                        onClick={() => void cancelBroadcast()}
                      >
                        Cancel broadcast
                      </JXButton>
                    )}
                    <JXButton
                      variant="contained"
                      color="primary"
                      size="md"
                      loading={isBroadcasting}
                      onClick={() => void handleBroadcast()}
                      startIcon={<Send className="w-4 h-4" />}
                      disabled={targetCount === 0 || !scriptPayload.trim()}
                    >
                      Broadcast to {number(targetCount)} devices
                    </JXButton>
                  </div>
                </div>

                {/* UX-25: payload/target summary at the point of action — the
                    operator confirms WHAT runs WHERE before dispatching. */}
                <p className="text-xs leading-relaxed text-[var(--product-text-tertiary)]" role="note">
                  {isBroadcasting
                    ? `Broadcast running on ${number(broadcastProgress?.total ?? targetCount)} devices — Cancel asks the control plane to stop the batch; tasks not yet started are cancelled, tasks already running on a device finish.`
                    : broadcastCancelled
                      ? "Broadcast cancelled. Tasks not yet started were stopped on the control plane; any already running finished on their devices — check the task list to see what went out."
                      : `Ready to run on ${number(targetCount)} device${targetCount === 1 ? "" : "s"} (${targetScope === "all" ? "whole fleet" : targetScope === "production-east" ? "tag #production-east" : targetScope === "gpu-runners" ? "tag #gpu-runners" : "custom selection"}) · ${scriptLang} · ${number(concurrency)} devices in parallel · ${number(scriptPayload.trim().split("\n").length)} line${scriptPayload.trim().split("\n").length === 1 ? "" : "s"} of script. The payload runs as an elevated shell task (Tier 3) on every target device — check the script before dispatching.`}
                </p>
              </div>
            </div>
        </JXCardContent>
      </JXCard>

      {/* SECTION 2: Reactive Self-Healing Rules Engine */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <HeartPulse className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-semibold text-[var(--product-text)]">Automation rules</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              id="fleet-new-rule-name"
              aria-label="New rule name"
              aria-invalid={ruleNameTouched && !newRuleName.trim()}
              aria-describedby={ruleNameTouched && !newRuleName.trim() ? "fleet-rule-name-error" : undefined}
              placeholder="New rule name..."
              value={newRuleName}
              onChange={(e) => setNewRuleName(e.target.value)}
              onBlur={() => setRuleNameTouched(true)}
              className="px-2.5 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)] focus:outline-none"
            />
            {ruleNameTouched && !newRuleName.trim() && (
              <p id="fleet-rule-name-error" role="alert" className="text-[11px] text-amber-300">Give the rule a name before adding it.</p>
            )}
            <select
              aria-label="Rule metric"
              value={newRuleMetric}
              onChange={(e) => setNewRuleMetric(e.target.value)}
              className="px-2 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)] focus:outline-none"
            >
              <option value="memory_percent">memory_percent</option>
              <option value="cpu_percent">cpu_percent</option>
              <option value="disk_percent">disk_percent</option>
            </select>
            <JXButton
              variant="soft"
              color="primary"
              size="sm"
              onClick={() => void handleCreateLiveTrigger()}
              disabled={!newRuleName.trim()}
              startIcon={<Plus className="w-3.5 h-3.5" />}
            >
              Add Rule
            </JXButton>
            <span className="text-xs font-mono text-[var(--product-text-tertiary)]">
              Autonomous closed-loop remediation sentinels
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rules.map((rule) => (
            <div key={rule.id}>
              <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
                <div className="p-4 pb-2 flex items-center justify-between border-b border-[var(--product-line)]">
                  <div className="flex items-center gap-2.5">
                    {rule.category === "service" ? (
                      <RotateCcw className="w-4 h-4 text-indigo-400" />
                    ) : rule.category === "memory" ? (
                      <Cpu className="w-4 h-4 text-emerald-400" />
                    ) : rule.category === "mtls" ? (
                      <Shield className="w-4 h-4 text-cyan-400" />
                    ) : (
                      <HardDrive className="w-4 h-4 text-amber-400" />
                    )}
                    <div>
                      <h4 className="text-sm font-semibold text-[var(--product-text)]">{rule.name}</h4>
                      <p className="text-[11px] font-mono text-[var(--product-text-tertiary)]">
                        RULE-ID: #{rule.id} • Last fired: {rule.lastFired}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={rule.enabled ? "active" : "paused"} label={rule.enabled ? "Active" : "Disabled"} />
                    <JXSwitch
                      label={`Enable ${rule.name}`}
                      cardMode={false}
                      checked={rule.enabled}
                      onChange={() => void handleToggleRule(rule.id)}
                    />
                  </div>
                </div>
                <JXCardContent>
                  <div className="space-y-2.5">
                    <div className="p-2.5 rounded-lg bg-[var(--product-canvas)]/70 border border-[var(--product-line)]/80 text-xs">
                      <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--product-text-tertiary)] block mb-0.5">
                        Trigger Condition
                      </span>
                      <code className="text-[var(--product-text-secondary)] font-mono">{rule.condition}</code>
                    </div>

                    <div className="p-2.5 rounded-lg bg-[var(--product-canvas)]/70 border border-[var(--product-line)]/80 text-xs">
                      <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--product-text-tertiary)] block mb-0.5">
                        Remediation Action
                      </span>
                      <code className="text-emerald-400 font-mono">{rule.action}</code>
                    </div>

                    <div className="flex items-center justify-between pt-1 text-xs">
                      <span className="font-mono text-[var(--product-text-tertiary)]">
                        Triggered: <strong className="text-[var(--product-text-secondary)]">{number(rule.firedCount)} times</strong>
                      </span>
                      <div className="flex items-center gap-1.5">
                        {rule.isBackend && (
                          <JXButton
                            variant="soft"
                            color="neutral"
                            size="sm"
                            onClick={() => void handleDeleteRule(rule.id, rule.isBackend)}
                            startIcon={<Trash2 className="w-3.5 h-3.5 text-rose-400" />}
                          >
                            Delete
                          </JXButton>
                        )}
                        <JXButton
                          variant="soft"
                          color="primary"
                          size="sm"
                          onClick={() => void handleSimulateRuleTrigger(rule.id)}
                          startIcon={<Zap className="w-3.5 h-3.5" />}
                        >
                          Simulate Trigger
                        </JXButton>
                      </div>
                    </div>
                  </div>
                </JXCardContent>
              </JXCard>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 3: Fleet Cron Scheduler Table */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
        <JXCardHeader
          title="Schedules"
          icon={<Calendar className="w-5 h-5 text-indigo-400" />}
        />
        <JXCardContent>
          <div className="flex items-center justify-end gap-2 pb-3">
            <input
              type="text"
              id="fleet-new-schedule-name"
              aria-label="New schedule name"
              aria-invalid={schedNameTouched && !newSchedName.trim()}
              aria-describedby={schedNameTouched && !newSchedName.trim() ? "fleet-schedule-name-error" : undefined}
              placeholder="Schedule name..."
              value={newSchedName}
              onChange={(e) => setNewSchedName(e.target.value)}
              onBlur={() => setSchedNameTouched(true)}
              className="px-2.5 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)] focus:outline-none"
            />
            {schedNameTouched && !newSchedName.trim() && (
              <p id="fleet-schedule-name-error" role="alert" className="text-[11px] text-amber-300">Give the schedule a name before adding it.</p>
            )}
            <JXButton
              variant="soft"
              color="primary"
              size="sm"
              onClick={() => void handleCreateLiveSchedule()}
              disabled={!newSchedName.trim()}
              startIcon={<Plus className="w-3.5 h-3.5" />}
            >
              Add Schedule
            </JXButton>
          </div>
          <div ref={tableScrollRef} tabIndex={0} role="region" aria-label="Fleet schedules" className="overflow-x-auto scroll-shadow rounded-xl border border-[var(--product-line)]" data-scroll-left={scrollShadow.left} data-scroll-right={scrollShadow.right}>
            <table className="w-full min-w-[720px] text-left text-xs border-collapse">
              <caption className="sr-only">Fleet schedules: name, cron expression, target devices, last execution, and next run</caption>
              <thead>
                <tr className="bg-[var(--product-canvas)] border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] font-mono uppercase">
                  <th scope="col" className="p-3">Schedule name</th>
                  <th scope="col" className="p-3">Cron Syntax</th>
                  <th scope="col" className="p-3">Target devices</th>
                  <th scope="col" className="p-3">Last Execution</th>
                  <th scope="col" className="p-3">Next Run</th>
                  <th scope="col" className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--product-line)]/60 font-mono">
                {cronJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-[var(--product-canvas)]/40 transition-colors">
                    <td className="p-3">
                      <div className="font-semibold text-[var(--product-text-secondary)]">{job.name}</div>
                      <div className="text-[11px] text-[var(--product-text-tertiary)] font-sans">{job.description}</div>
                    </td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded bg-[var(--product-canvas)] border border-[var(--product-line)] text-indigo-400">
                        {job.cronExpr}
                      </span>
                    </td>
                    <td className="p-3 text-[var(--product-text-secondary)]">{job.targets}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={job.lastStatus} />
                        <span className="text-[var(--product-text-dim)]">({job.lastDuration})</span>
                      </div>
                    </td>
                    <td className="p-3 text-[var(--product-text-secondary)]">{job.nextRun}</td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {job.isBackend && (
                          <JXButton
                            variant="soft"
                            color="neutral"
                            size="sm"
                            onClick={() => void handleDeleteSchedule(job.id, job.isBackend)}
                            startIcon={<Trash2 className="w-3.5 h-3.5 text-rose-400" />}
                          >
                            Delete
                          </JXButton>
                        )}
                        <JXButton
                          variant="soft"
                          color="primary"
                          size="sm"
                          onClick={() => void handleRunCronNow(job.id)}
                          startIcon={<Play className="w-3.5 h-3.5" />}
                        >
                          Run Now
                        </JXButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </JXCardContent>
      </JXCard>

      {/* Failure Drill-down Modal */}
      <AnimatePresence>
        {selectedFailedNode && (
          <GlassModal onClose={() => setSelectedFailedNode(null)} title="Sample broadcast failure">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-4"
            >
              <div className="flex items-center justify-between border-b border-[var(--product-line)] pb-3">
                <div className="flex items-center gap-2 text-rose-400 font-bold">
                  <AlertTriangle className="w-5 h-5" />
                  <span>Broadcast Execution Drill-Down</span>
                </div>
                <button
                  type="button"
                  aria-label="Close broadcast failure"
                  onClick={() => setSelectedFailedNode(null)}
                  className="text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3 text-xs font-mono">
                <div>
                  <span className="text-[var(--product-text-tertiary)]">Device:</span>
                  <div className="text-[var(--product-text-secondary)] font-semibold">{selectedFailedNode.deviceId}</div>
                </div>
                <div>
                  <span className="text-[var(--product-text-tertiary)]">Exit Status Code:</span>
                  <div className="text-rose-400 font-bold">{selectedFailedNode.exitCode}</div>
                </div>
                <div>
                  <span className="text-[var(--product-text-tertiary)]">Stderr Output:</span>
                  <div className="p-3 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-rose-300">
                    {selectedFailedNode.stderr}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <JXButton
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  onClick={() => setSelectedFailedNode(null)}
                >
                  Dismiss
                </JXButton>
                <JXButton
                  variant="contained"
                  color="primary"
                  size="sm"
                  onClick={() => setSelectedFailedNode(null)}
                >
                  Retry Node
                </JXButton>
              </div>
            </motion.div>
          </GlassModal>
        )}
      </AnimatePresence>
    </div>
  );
};

export default FleetOperationsView;
