/**
 * AI Bridge Enterprise Dashboard — Task Queue & Vision Inspector (Screen 4)
 * Split-screen Tool Dispatch Studio & Execution Queue with Set-of-Marks (SoM) Vision Inspector.
 * Strict JXUI Primitives & Lucide Icons. ZERO inline styles.
 */

import React, { useState, useMemo, useEffect, useCallback } from "react";
import {
  JXBox,
  JXStack,
  JXGrid,
  JXGridItem,
  JXCard,
  JXCardHeader,
  JXCardContent,
  JXBadge,
  JXButton,
  StatusBadge,
  ConfirmDestructive,
  EmptyState,
} from "../ui";
import {
  Zap,
  Send,
  Check,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Sliders,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Copy,
  Terminal,
  Monitor,
  FileText,
  Shield,
  Search,
  Code,
  Layers,
  Bot,
  User,
  Download,
  Eye,
  Crosshair,
  Sparkles,
  Trash2,
  Ban,
  Camera,
  RotateCcw,
  Pencil,
} from "lucide-react";
import { api, token, sessionToken } from "../api";
import { useDashboardStore } from "../state/dashboardStore";
import { pushNotice } from "../state/notices";
import { Freshness } from "../components/Freshness";
import { GlossaryModal } from "../components/Glossary";
import { readRoute, updateRouteParams, taskStatuses } from "../state/navigation";
import type { TaskInvocation, TaskRiskTier, TaskStatus } from "../types/dashboard";

interface SoMMark {
  id: number;
  label: string;
  category: string;
  bounds: [number, number, number, number]; // [x, y, width, height] in percentage
  color: string;
  positionClass: string;
}

const DEFAULT_SOM_MARKS: SoMMark[] = [
  {
    id: 1,
    label: "Terminal Bounding Box (root@srv-us-east-412)",
    category: "Shell / PTY",
    bounds: [4, 8, 54, 46],
    color: "border-cyan-400 bg-cyan-500/10 text-cyan-300",
    positionClass: "left-[4%] top-[8%] w-[54%] h-[46%]",
  },
  {
    id: 2,
    label: "Bridge Gateway Inspector Web UI",
    category: "Browser Canvas",
    bounds: [62, 8, 34, 46],
    color: "border-indigo-400 bg-indigo-500/10 text-indigo-300",
    positionClass: "left-[62%] top-[8%] w-[34%] h-[46%]",
  },
  {
    id: 3,
    label: "Desktop Status Tray & IPC Channel",
    category: "Taskbar Element",
    bounds: [4, 60, 92, 16],
    color: "border-emerald-400 bg-emerald-500/10 text-emerald-300",
    positionClass: "left-[4%] top-[60%] w-[92%] h-[16%]",
  },
  {
    id: 4,
    label: "System Security Dialog [PCR-7 Active]",
    category: "Authentication Gate",
    bounds: [30, 80, 40, 14],
    color: "border-amber-400 bg-amber-500/10 text-amber-300",
    positionClass: "left-[30%] top-[80%] w-[40%] h-[14%]",
  },
];

const PRESETS = [
  {
    name: "Full 4K Screenshot",
    tool: "desktop_get_screenshot",
    tier: "tier1_safe" as TaskRiskTier,
    payload: {
      monitor_index: 0,
      format: "png",
      quality: 85,
      include_som_metadata: true,
    },
  },
  {
    name: "Window Capture",
    tool: "desktop_get_window_screenshot",
    tier: "tier1_safe" as TaskRiskTier,
    payload: {
      target_window: "active",
      format: "png",
    },
  },
  {
    name: "Fleet Status",
    tool: "list_devices",
    tier: "tier1_safe" as TaskRiskTier,
    payload: {},
  },
  {
    name: "System Specs",
    tool: "get_system_info",
    tier: "tier1_safe" as TaskRiskTier,
    payload: {
      format: "json",
      include_hardware: true,
      include_network: true,
    },
  },
  {
    name: "Tail Journal",
    tool: "run_shell",
    tier: "tier3_shell" as TaskRiskTier,
    payload: {
      command: "journalctl -u ai-bridge-agent -f -n 50",
      timeout_seconds: 30,
    },
  },
];

/** UX-34: a recent dispatch, persisted so the operator can re-dispatch
 * without re-selecting device + tool + args. */
interface RecentDispatch {
  deviceId: string;
  tool: string;
  args: Record<string, unknown>;
  riskTier: TaskRiskTier;
  dispatchedAt: number;
  taskId?: string;
}

const RECENT_DISPATCHES_KEY = "ai-bridge:recent-dispatches:v1";
const MAX_RECENT_DISPATCHES = 8;

function loadRecentDispatches(): RecentDispatch[] {
  try {
    const raw = localStorage.getItem(RECENT_DISPATCHES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentDispatch =>
          !!e &&
          typeof e === "object" &&
          typeof (e as RecentDispatch).deviceId === "string" &&
          typeof (e as RecentDispatch).tool === "string" &&
          !!(e as RecentDispatch).args &&
          typeof (e as RecentDispatch).args === "object" &&
          !Array.isArray((e as RecentDispatch).args)
      )
      .slice(0, MAX_RECENT_DISPATCHES);
  } catch {
    return [];
  }
}

export const TaskQueueVisionView: React.FC = () => {
  const devices = useDashboardStore((s) => s.devices);
  const selectedDeviceId = useDashboardStore((s) => s.selectedDeviceId);
  const storeTasks = useDashboardStore((s) => s.tasks);
  const approvals = useDashboardStore((s) => s.approvals);
  const resolveApproval = useDashboardStore((s) => s.resolveApproval);
  const dispatchTask = useDashboardStore((s) => s.dispatchTask);
  const refreshLive = useDashboardStore((s) => s.refreshLive);
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  const getSyncState = useDashboardStore((s) => s.getSyncState);
  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());

  // Studio form states
  const [targetDeviceId, setTargetDeviceId] = useState<string>(selectedDeviceId || "srv-us-east-412");
  const [selectedTool, setSelectedTool] = useState<string>("desktop_get_screenshot");
  const [activeRiskTier, setActiveRiskTier] = useState<TaskRiskTier>("tier1_safe");
  const [argsJson, setArgsJson] = useState<string>(
    JSON.stringify(PRESETS[0].payload, null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [activePreset, setActivePreset] = useState<string>("Full 4K Screenshot");

  // Queue and inspector states
  // UX-13: list filters initialise from the hash (?q= / ?status=) so a
  // filtered list survives refresh and can be shared; they are written
  // back (replaceState) when they change.
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const s = typeof window === "undefined" ? undefined : readRoute().status;
    return s && (taskStatuses as readonly string[]).includes(s) ? s : "all";
  });
  const [searchQuery, setSearchQuery] = useState<string>(() =>
    typeof window === "undefined" ? "" : readRoute().q ?? ""
  );
  const [deviceFilter, setDeviceFilter] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  // UX-09: default to server history when live — the store's synced list
  // may not contain the authoritative record for a just-dispatched task.
  const [useServerHistory, setUseServerHistory] = useState<boolean>(() => isLive);
  const [historyTasks, setHistoryTasks] = useState<TaskInvocation[]>([]);
  const [historyTotal, setHistoryTotal] = useState<number>(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReload, setHistoryReload] = useState<number>(0);
  // UX-13: true once the first server-history load has settled, so a
  // deep-linked task is only declared missing after the list exists.
  const [historyLoaded, setHistoryLoaded] = useState<boolean>(false);
  const PAGE_SIZE = 12;
  const tasks = useServerHistory && isLive ? historyTasks : storeTasks;
  // UX-13: task deep link (?task=<id>). The id from the hash is the
  // initial selection; unknown ids render an explicit "Task not
  // available" state and never fall back to the first task (UX-27).
  const [routeTaskId, setRouteTaskId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readRoute().task ?? null
  );
  const [taskNotFound, setTaskNotFound] = useState<boolean>(false);
  // A deep-linked task that exists on the server but is not on the loaded
  // page (live server history is paginated) is fetched once and held here
  // so the inspector can show it without a silent fallback.
  const [linkedTask, setLinkedTask] = useState<TaskInvocation | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string>(routeTaskId ?? storeTasks[0]?.id ?? "TSK-89213");
  // UX-13: a deep-linked id is resolved once; afterwards the user's own
  // selection wins and list refreshes must not re-select or re-scroll.
  const resolvedRouteTaskRef = React.useRef<string | null>(null);
  // UX-13: selecting a task writes ?task=<id> back to the hash.
  const selectTask = useCallback((id: string) => {
    resolvedRouteTaskRef.current = id;
    setRouteTaskId(id);
    setSelectedTaskId(id);
    setTaskNotFound(false);
    updateRouteParams({ task: id });
  }, []);
  // UX-25: glossary modal opened from the tier legend.
  const [glossaryOpen, setGlossaryOpen] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0); // 1.0 = Fit, 1.5, 2.0
  const [somEnabled, setSomEnabled] = useState<boolean>(true);
  const [selectedMarkId, setSelectedMarkId] = useState<number | null>(null);
  const [copiedPayload, setCopiedPayload] = useState<boolean>(false);
  const [liveCapturedBase64, setLiveCapturedBase64] = useState<string>("");
  // UX-03/UX-04: pending confirmations. The destructive/ elevated action
  // only runs from the ConfirmDestructive onConfirm — never from the row
  // button or the dispatch button directly.
  const [dispatchDraft, setDispatchDraft] = useState<{
    deviceId: string;
    tool: string;
    args: Record<string, unknown>;
    riskTier: TaskRiskTier;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState<boolean>(false);
  // UX-23: one busy key at a time ("delete:<id>", "clear", "cancel:<id>",
  // "retry:<id>", "decide:<id>"); buttons disable while their key is set.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // UX-09: the most recently dispatched task, tracked persistently in-view.
  const [trackedTaskId, setTrackedTaskId] = useState<string | null>(null);
  // UX-39: run_shell shows a typed command form; raw JSON is the toggle.
  const [showRawJson, setShowRawJson] = useState<boolean>(false);
  // UX-23: idempotency key for the current dispatch intent. Created once
  // when the confirm opens and reused on retry, so a second click cannot
  // create a second task. Cleared only after a successful dispatch.
  const dispatchKeyRef = React.useRef<string | null>(null);
  // UX-34: recent dispatches, persisted in localStorage (max 8).
  const [recentDispatches, setRecentDispatches] = useState<RecentDispatch[]>(loadRecentDispatches);
  const [editingTask, setEditingTask] = useState<TaskInvocation | null>(null);
  const [editTool, setEditTool] = useState<string>("");
  const [editArgsJson, setEditArgsJson] = useState<string>("{}");
  const [editError, setEditError] = useState<string | null>(null);

  // Sync risk tier when tool changes
  useEffect(() => {
    if (
      selectedTool.startsWith("desktop_get") ||
      selectedTool === "desktop_get_screenshot" ||
      selectedTool === "get_system_info" ||
      selectedTool === "list_devices" ||
      selectedTool === "get_device_status" ||
      selectedTool === "read_file" ||
      selectedTool.startsWith("desktop.capture") ||
      selectedTool.startsWith("system.specs") ||
      selectedTool.startsWith("process.list")
    ) {
      setActiveRiskTier("tier1_safe");
    } else if (
      selectedTool.startsWith("desktop_") ||
      selectedTool === "write_file" ||
      selectedTool === "apply_patch" ||
      selectedTool.startsWith("desktop.click") ||
      selectedTool.startsWith("desktop.type") ||
      selectedTool.startsWith("file.")
    ) {
      setActiveRiskTier("tier2_workspace");
    } else if (
      selectedTool === "run_shell" ||
      selectedTool.startsWith("shell.exec") ||
      selectedTool.startsWith("pty.spawn")
    ) {
      setActiveRiskTier("tier3_shell");
    } else {
      setActiveRiskTier("tier4_kernel");
    }
  }, [selectedTool]);

  // Validate JSON on edit
  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setArgsJson(val);
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(err.message || "Invalid JSON syntax");
    }
  };

  const beautifyJson = () => {
    try {
      const parsed = JSON.parse(argsJson);
      setArgsJson(JSON.stringify(parsed, null, 2));
      setJsonError(null);
    } catch (err: any) {
      setJsonError(err.message || "Cannot format malformed JSON");
    }
  };

  const applyPreset = (preset: typeof PRESETS[0]) => {
    setActivePreset(preset.name);
    setSelectedTool(preset.tool);
    setActiveRiskTier(preset.tier);
    setArgsJson(JSON.stringify(preset.payload, null, 2));
    setJsonError(null);
  };

  // UX-39: the args object parsed from the JSON editor (null while the
  // JSON is invalid). The run_shell command form reads/writes through it.
  const parsedArgs = useMemo<Record<string, unknown> | null>(() => {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [argsJson]);

  const updateShellArg = useCallback(
    (patch: Record<string, unknown>) => {
      const base = parsedArgs ?? {};
      setArgsJson(JSON.stringify({ ...base, ...patch }, null, 2));
      setJsonError(null);
    },
    [parsedArgs]
  );

  const recordRecentDispatch = useCallback((entry: RecentDispatch) => {
    setRecentDispatches((prev) => {
      const keyOf = (e: RecentDispatch) =>
        `${e.deviceId}|${e.tool}|${JSON.stringify(e.args)}`;
      const next = [entry, ...prev.filter((e) => keyOf(e) !== keyOf(entry))].slice(
        0,
        MAX_RECENT_DISPATCHES
      );
      try {
        localStorage.setItem(RECENT_DISPATCHES_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode, quota): the list just won't persist.
      }
      return next;
    });
  }, []);

  // UX-04/UX-10: form submit (and Ctrl+Enter) only validates the JSON and
  // opens the confirm dialog. Nothing dispatches from here.
  const openDispatchConfirm = useCallback(() => {
    if (isSubmitting) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(argsJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError("Args must be a JSON object.");
        return;
      }
    } catch {
      setJsonError("Cannot dispatch: JSON payload is invalid");
      return;
    }
    if (!dispatchKeyRef.current) {
      dispatchKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    setDispatchDraft({
      deviceId: targetDeviceId,
      tool: selectedTool,
      args: parsed,
      riskTier: activeRiskTier,
    });
  }, [isSubmitting, argsJson, targetDeviceId, selectedTool, activeRiskTier]);

  // UX-04/UX-09/UX-23: runs only from ConfirmDestructive. When live the
  // stored idempotency key is sent with the request, so retrying the same
  // dispatch (e.g. after a failed attempt) cannot create a second task.
  const confirmDispatch = useCallback(async () => {
    const draft = dispatchDraft;
    if (!draft || isSubmitting) return;
    setIsSubmitting(true);
    try {
      let newTask: TaskInvocation | undefined;
      if (isLive) {
        const res = await api.submitTask(
          draft.deviceId,
          draft.tool,
          draft.args,
          undefined,
          // The stored key is a UUID string; the cast only bridges the
          // template-literal parameter type of submitTask's requestKey.
          dispatchKeyRef.current as Parameters<typeof api.submitTask>[4] | undefined
        );
        newTask = res as TaskInvocation | undefined;
      } else {
        newTask = await dispatchTask({
          deviceId: draft.deviceId,
          tool: draft.tool,
          args: draft.args,
          riskTier: draft.riskTier,
        });
      }
      const createdId = newTask?.id || (newTask as unknown as { task_id?: string })?.task_id;
      const deviceName =
        devices.find((d) => d.id === draft.deviceId)?.hostname || draft.deviceId;
      if (createdId) {
        selectTask(createdId);
        setTrackedTaskId(createdId);
      }
      recordRecentDispatch({
        deviceId: draft.deviceId,
        tool: draft.tool,
        args: draft.args,
        riskTier: draft.riskTier,
        dispatchedAt: Date.now(),
        taskId: createdId,
      });
      // The dispatch intent is complete: a later, different dispatch gets
      // a fresh key. A failed dispatch keeps the key for its retry.
      dispatchKeyRef.current = null;
      setDispatchDraft(null);
      pushNotice({
        tone: "success",
        title: createdId ? `Task #${createdId} dispatched` : "Task dispatched",
        message: `${draft.tool} on ${deviceName} (${draft.riskTier.replace("_", " ")}).`,
        actionLabel: createdId ? "View task" : undefined,
        actionHref: createdId ? "#task-queue-and-vision" : undefined,
      });
      await refreshLive?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Task dispatch rejected";
      setJsonError(message);
      pushNotice({ tone: "error", title: "Task dispatch failed", message });
    } finally {
      setIsSubmitting(false);
    }
  }, [dispatchDraft, isSubmitting, isLive, devices, dispatchTask, recordRecentDispatch, refreshLive, selectTask]);

  // UX-34: re-dispatch a recent entry — refill the form and open the same
  // confirm dialog (with a fresh idempotency key for the new intent).
  const redispatchRecent = useCallback((entry: RecentDispatch) => {
    setTargetDeviceId(entry.deviceId);
    setSelectedTool(entry.tool);
    setActiveRiskTier(entry.riskTier);
    setArgsJson(JSON.stringify(entry.args, null, 2));
    setJsonError(null);
    setActivePreset("");
    if (!dispatchKeyRef.current) {
      dispatchKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    setDispatchDraft({
      deviceId: entry.deviceId,
      tool: entry.tool,
      args: entry.args,
      riskTier: entry.riskTier,
    });
  }, []);

  const loadRecentIntoForm = useCallback((entry: RecentDispatch) => {
    setTargetDeviceId(entry.deviceId);
    setSelectedTool(entry.tool);
    setActiveRiskTier(entry.riskTier);
    setArgsJson(JSON.stringify(entry.args, null, 2));
    setJsonError(null);
    setActivePreset("");
  }, []);

  const handleCancelTask = useCallback(
    async (taskId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const key = `cancel:${taskId}`;
      if (pendingAction) return;
      setPendingAction(key);
      if (Boolean(token() || sessionToken())) {
        try {
          await api.cancelTask(taskId);
          await refreshLive?.();
          pushNotice({ tone: "success", title: `Cancelled task #${taskId}.` });
        } catch (err: unknown) {
          pushNotice({
            tone: "error",
            title: "Cancel failed",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        } finally {
          setPendingAction(null);
        }
        return;
      }
      pushNotice({ tone: "info", title: `Simulated cancellation for #${taskId}.` });
      setPendingAction(null);
    },
    [pendingAction, refreshLive]
  );

  // UX-03: the row button only opens the confirm dialog; the API call
  // happens in confirmDeleteTask.
  const requestDeleteTask = useCallback((taskId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDeleteTarget(taskId);
  }, []);

  const confirmDeleteTask = useCallback(async () => {
    const taskId = deleteTarget;
    if (!taskId) return;
    const key = `delete:${taskId}`;
    if (pendingAction) return;
    setDeleteTarget(null);
    setPendingAction(key);
    if (Boolean(token() || sessionToken())) {
      try {
        await api.deleteTask(taskId);
        await refreshLive?.();
        pushNotice({ tone: "success", title: `Deleted task #${taskId}.` });
      } catch (err: unknown) {
        pushNotice({
          tone: "error",
          title: "Delete failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setPendingAction(null);
      }
      return;
    }
    pushNotice({ tone: "info", title: `Simulated deletion for #${taskId}.` });
    setPendingAction(null);
  }, [deleteTarget, pendingAction, refreshLive]);

  const confirmClearTasks = useCallback(async () => {
    if (pendingAction) return;
    setClearConfirmOpen(false);
    setPendingAction("clear");
    if (Boolean(token() || sessionToken())) {
      try {
        const res = await api.clearTasks(statusFilter !== "all" ? statusFilter : undefined);
        await refreshLive?.();
        pushNotice({ tone: "success", title: `Cleared ${res?.deleted_count ?? 0} tasks.` });
      } catch (err: unknown) {
        pushNotice({
          tone: "error",
          title: "Clear tasks failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setPendingAction(null);
      }
      return;
    }
    pushNotice({ tone: "info", title: "Simulated clearing finished tasks." });
    setPendingAction(null);
  }, [pendingAction, statusFilter, refreshLive]);

  const findApprovalIdForTask = useCallback(
    (task: TaskInvocation): string | undefined => {
      if (task.approvalId) return task.approvalId;
      return approvals.find((a) => a.taskId === task.id && a.status === "pending")?.id;
    },
    [approvals]
  );

  // UX-09: the approval for a task (pending first, otherwise the most
  // recent one), so the row can show its id/status and link to it.
  const findApprovalForTask = useCallback(
    (task: TaskInvocation) => {
      if (task.approvalId) {
        return approvals.find((a) => a.id === task.approvalId);
      }
      return (
        approvals.find((a) => a.taskId === task.id && a.status === "pending") ||
        approvals.find((a) => a.taskId === task.id)
      );
    },
    [approvals]
  );

  const handleDecideTask = useCallback(
    async (task: TaskInvocation, verdict: "approved" | "denied", e?: React.MouseEvent) => {
      e?.stopPropagation();
      const approvalId = findApprovalIdForTask(task);
      if (!approvalId) {
        // UX-09: dead-ending in a notice is not enough — link to the
        // Human Approvals view where the record (if any) lives.
        pushNotice({
          tone: "warning",
          title: `No pending approval record found for task #${task.id}.`,
          message: "Open Human Approvals to review the approval for this task.",
          actionLabel: "Open Human Approvals",
          actionHref: "#human-approvals",
        });
        return;
      }
      const key = `decide:${task.id}`;
      if (pendingAction) return;
      setPendingAction(key);
      try {
        await resolveApproval(
          approvalId,
          verdict,
          verdict === "approved"
            ? "Approved from Task Queue"
            : "Denied from Task Queue"
        );
        await refreshLive?.();
        pushNotice({
          tone: "success",
          title: `${verdict === "approved" ? "Approved" : "Denied"} task #${task.id}.`,
        });
      } catch (err: unknown) {
        pushNotice({
          tone: "error",
          title: `${verdict === "approved" ? "Approve" : "Deny"} failed`,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setPendingAction(null);
      }
    },
    [findApprovalIdForTask, resolveApproval, refreshLive, pendingAction]
  );

  const handleRetryTask = useCallback(
    async (task: TaskInvocation, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const key = `retry:${task.id}`;
      if (pendingAction) return;
      setPendingAction(key);
      if (Boolean(token() || sessionToken())) {
        try {
          await api.updateTask(task.id, { status: "queued" });
          await refreshLive?.();
          pushNotice({ tone: "success", title: `Re-queued task #${task.id}.` });
        } catch (err: unknown) {
          pushNotice({
            tone: "error",
            title: "Retry failed",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        } finally {
          setPendingAction(null);
        }
        return;
      }
      await dispatchTask({ deviceId: task.deviceId, tool: task.tool, args: task.args, riskTier: task.riskTier });
      pushNotice({ tone: "info", title: `Re-dispatched ${task.tool}.` });
      setPendingAction(null);
    },
    [dispatchTask, refreshLive, pendingAction]
  );

  const openEditTask = useCallback((task: TaskInvocation, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingTask(task);
    setEditTool(task.tool);
    setEditArgsJson(JSON.stringify(task.args || {}, null, 2));
    setEditError(null);
  }, []);

  const handleSaveTaskEdit = useCallback(async () => {
    if (!editingTask) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = editArgsJson.trim() ? JSON.parse(editArgsJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setEditError("Args must be a JSON object.");
        return;
      }
    } catch (err: any) {
      setEditError(err?.message || "Invalid JSON.");
      return;
    }
    try {
      if (Boolean(token() || sessionToken())) {
        await api.updateTask(editingTask.id, { tool: editTool.trim(), args: parsed });
        await refreshLive?.();
      }
      pushNotice({ tone: "success", title: `Updated task #${editingTask.id}.` });
      setEditingTask(null);
    } catch (err: any) {
      setEditError(err?.message || "Failed to update task.");
    }
  }, [editingTask, editTool, editArgsJson, refreshLive]);

  useEffect(() => {
    if (!useServerHistory || !isLive) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.taskHistory({
          q: searchQuery,
          status: statusFilter === "all" ? "all" : statusFilter,
          device_id: deviceFilter === "all" ? "" : deviceFilter,
          tenant: "default",
          page,
        });
        if (cancelled) return;
        const items = (Array.isArray(res?.items) ? res.items : []).map((row: Record<string, unknown>) => {
          let args: Record<string, unknown> = {};
          try {
            args =
              typeof row.args_json === "string"
                ? JSON.parse(row.args_json as string)
                : ((row.args as Record<string, unknown>) || {});
          } catch {
            args = {};
          }
          const tierNum = Number(row.tier ?? 1);
          const riskTier: TaskRiskTier =
            tierNum >= 4
              ? "tier4_kernel"
              : tierNum >= 3
                ? "tier3_shell"
                : tierNum >= 2
                  ? "tier2_workspace"
                  : "tier1_safe";
          return {
            id: String(row.id || ""),
            tool: String(row.tool || ""),
            status: String(row.status || "pending") as TaskStatus,
            deviceId: String(row.device_id || ""),
            deviceHostname: String(row.device_id || ""),
            riskTier,
            args,
            invoker: "history",
            createdAt: String(row.created_at || ""),
          } as TaskInvocation;
        });
        setHistoryTasks(items);
        setHistoryTotal(Number(res?.total) || items.length);
        setHistoryError(null);
        setHistoryLoaded(true);
      } catch (err: unknown) {
        if (!cancelled) {
          setHistoryTasks([]);
          setHistoryTotal(0);
          setHistoryLoaded(true);
          // UX-23: a failed load is recoverable in-view (Retry below),
          // not only by reloading the page.
          setHistoryError(
            err instanceof Error ? err.message : "Could not load server task history."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [useServerHistory, isLive, searchQuery, statusFilter, deviceFilter, page, historyReload]);

  // Filtered task list (client-side when not using server history)
  const filteredTasks = useMemo(() => {
    if (useServerHistory && isLive) return tasks;
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (deviceFilter !== "all" && t.deviceId !== deviceFilter) return false;
      if (q && !t.id.toLowerCase().includes(q) && !t.tool.toLowerCase().includes(q) && !(t.deviceHostname || t.deviceId).toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [tasks, statusFilter, deviceFilter, searchQuery, useServerHistory, isLive]);

  const totalPages = Math.max(
    1,
    useServerHistory && isLive
      ? Math.ceil(historyTotal / PAGE_SIZE)
      : Math.ceil(filteredTasks.length / PAGE_SIZE)
  );
  const safePage = Math.min(page, totalPages);
  const pagedTasks = useMemo(() => {
    if (useServerHistory && isLive) return filteredTasks;
    return filteredTasks.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [filteredTasks, safePage, useServerHistory, isLive]);

  useEffect(() => {
    setPage(1);
  }, [statusFilter, deviceFilter, searchQuery, useServerHistory]);

  // UX-13: write the list filters back to the hash (replaceState, so
  // typing a search does not spam history). updateRouteParams merges, so
  // ?task= is preserved.
  useEffect(() => {
    updateRouteParams(
      { q: searchQuery || undefined, status: statusFilter !== "all" ? statusFilter : undefined },
      true
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, statusFilter]);

  // UX-13: resolve the ?task= deep link once the list exists. If the id
  // is on the loaded list, select it and scroll to its row. In live mode
  // the list is one server-history page, so an id that is not on the page
  // is probed with taskDetail before it is declared missing.
  useEffect(() => {
    if (!routeTaskId || resolvedRouteTaskRef.current === routeTaskId) return;
    if (useServerHistory && isLive && !historyLoaded) return;
    if (tasks.some((t) => t.id === routeTaskId)) {
      resolvedRouteTaskRef.current = routeTaskId;
      setSelectedTaskId(routeTaskId);
      setTaskNotFound(false);
      requestAnimationFrame(() => {
        document.getElementById(`task-row-${routeTaskId}`)?.scrollIntoView({ block: "nearest" });
      });
      return;
    }
    if (linkedTask && linkedTask.id === routeTaskId) {
      resolvedRouteTaskRef.current = routeTaskId;
      setSelectedTaskId(routeTaskId);
      setTaskNotFound(false);
      return;
    }
    if (isLive) {
      let cancelled = false;
      api
        .taskDetail(routeTaskId)
        .then((res: any) => {
          if (cancelled) return;
          if (!res || typeof res !== "object" || !res.id) {
            resolvedRouteTaskRef.current = routeTaskId;
            setTaskNotFound(true);
            return;
          }
          const tierNum = Number(res.tier ?? 1);
          setLinkedTask({
            id: String(res.id),
            deviceId: String(res.device_id || ""),
            deviceHostname: String(res.device_id || ""),
            tool: String(res.tool || ""),
            args: typeof res.args_json === "string" ? JSON.parse(res.args_json || "{}") : (res.args || {}),
            riskTier: (tierNum >= 4 ? "tier4_kernel" : tierNum >= 3 ? "tier3_shell" : tierNum >= 2 ? "tier2_workspace" : "tier1_safe") as TaskRiskTier,
            status: (res.status || "pending") as TaskStatus,
            invoker: "history",
            createdAt: String(res.created_at || ""),
          });
          resolvedRouteTaskRef.current = routeTaskId;
          setSelectedTaskId(routeTaskId);
          setTaskNotFound(false);
        })
        .catch(() => {
          if (!cancelled) {
            resolvedRouteTaskRef.current = routeTaskId;
            setTaskNotFound(true);
          }
        });
      return () => {
        cancelled = true;
      };
    }
    resolvedRouteTaskRef.current = routeTaskId;
    setTaskNotFound(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, historyLoaded, routeTaskId]);

  // Active inspected task
  const [liveTaskDetailResult, setLiveTaskDetailResult] = useState<any>(null);
  const baseActiveTask = useMemo(() => {
    const found = tasks.find((t) => t.id === selectedTaskId);
    if (found) return found;
    if (linkedTask && linkedTask.id === selectedTaskId) return linkedTask;
    // UX-27: a deep-linked id that is not in the list never falls back to
    // the first task — the caller renders "Task not available" instead.
    if (routeTaskId && selectedTaskId === routeTaskId) return undefined;
    return tasks[0];
  }, [tasks, selectedTaskId, linkedTask, routeTaskId]);

  useEffect(() => {
    if (!isLive || !selectedTaskId) {
      setLiveTaskDetailResult(null);
      return;
    }
    let cancelled = false;
    api
      .taskDetail(selectedTaskId)
      .then((res) => {
        if (!cancelled && res && typeof res === "object") {
          setLiveTaskDetailResult(res.result ?? res);
        }
      })
      .catch(() => {
        if (!cancelled) setLiveTaskDetailResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isLive, selectedTaskId]);

  const activeTask = useMemo(() => {
    if (!baseActiveTask) return undefined;
    if (liveTaskDetailResult && !baseActiveTask.result) {
      return { ...baseActiveTask, result: liveTaskDetailResult };
    }
    return baseActiveTask;
  }, [baseActiveTask, liveTaskDetailResult]);

  const handleCaptureLiveScreenshot = useCallback(async () => {
    if (Boolean(token() || sessionToken())) {
      const devId = activeTask?.deviceId || targetDeviceId;
      if (pendingAction) return;
      setPendingAction("capture");
      try {
        const frame = await api.desktopFrame(devId);
        if (frame?.base64_data) {
          setLiveCapturedBase64(frame.base64_data);
          pushNotice({ tone: "success", title: `Captured live frame from ${devId}.` });
        } else {
          pushNotice({
            tone: "warning",
            title: "No live frame available from device.",
            message: frame?.error || undefined,
          });
        }
      } catch (err: unknown) {
        pushNotice({
          tone: "error",
          title: "Screenshot capture failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setPendingAction(null);
      }
    }
  }, [activeTask, targetDeviceId, pendingAction]);

  // Keyboard shortcut listener (⌘/Ctrl + Enter) — UX-04: opens the same
  // confirm dialog as the Dispatch button; it never dispatches directly.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        openDispatchConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openDispatchConfirm]);

  const liveScreenshotDataUrl = useMemo(() => {
    const res: any = activeTask?.result;
    let rawB64 =
      res?.screenshotBase64 ||
      res?.base64_data ||
      res?.outputJson?.base64_data ||
      res?.outputJson?.screenshotBase64 ||
      "";
    if (!rawB64 && typeof res?.stdout === "string") {
      try {
        const parsed = JSON.parse(res.stdout);
        rawB64 = parsed?.base64_data || parsed?.screenshotBase64 || parsed?.image_base64 || "";
      } catch {
        // Not JSON stdout
      }
    }
    if (!rawB64 && liveCapturedBase64) {
      rawB64 = liveCapturedBase64;
    }
    if (!rawB64 || typeof rawB64 !== "string") return "";
    return rawB64.startsWith("data:image/") ? rawB64 : `data:image/jpeg;base64,${rawB64}`;
  }, [activeTask, liveCapturedBase64]);

  const copyToClipboard = () => {
    const payload = JSON.stringify(activeTask?.result || { status: "queued", task: activeTask }, null, 2);
    navigator.clipboard?.writeText(payload);
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  // Zoom handlers
  const handleZoomIn = () => setZoomLevel((prev) => Math.min(2.5, prev + 0.25));
  const handleZoomOut = () => setZoomLevel((prev) => Math.max(0.75, prev - 0.25));
  const handleZoomReset = () => setZoomLevel(1.0);

  const getRiskBadgeColor = (tier: TaskRiskTier) => {
    switch (tier) {
      case "tier1_safe":
        return "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";
      case "tier2_workspace":
        return "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30";
      case "tier3_shell":
        return "bg-amber-500/15 text-amber-300 border border-amber-500/30";
      case "tier4_kernel":
        return "bg-rose-500/15 text-rose-300 border border-rose-500/30";
    }
  };

  // UX-09: the tracked task, resolved live from the store list so the
  // tracking chip below always shows its current status.
  const trackedTask = useMemo(
    () => (trackedTaskId ? tasks.find((t) => t.id === trackedTaskId) : undefined),
    [trackedTaskId, tasks]
  );

  const clearScopeCount = useServerHistory && isLive ? historyTotal : filteredTasks.length;

  return (
    <div className="space-y-4">
      {/* UX-36/UX-06: explicit <h1> plus the live sync indicator. */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[var(--product-text)]">Task Queue &amp; Vision</h1>
          <p className="text-xs text-[var(--product-text-tertiary)]">
            Dispatch a task to a device and inspect the result.
          </p>
        </div>
        {isLive && (
          <Freshness checkedAt={lastSyncAt} loading={syncState === "loading" || getSyncState() === "loading"} />
        )}
      </header>
      {isLive && syncError && (
        <div role="alert" className="px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono flex items-center justify-between gap-2">
          <span>Sync with the control plane failed: {syncError}</span>
          <button
            type="button"
            onClick={() => void refreshLive?.()}
            className="px-2.5 py-1 rounded-lg bg-rose-500/20 border border-rose-500/40 font-semibold shrink-0"
          >
            Retry
          </button>
        </div>
      )}
      {trackedTaskId && (
        <div role="status" className="px-3 py-2 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-200 text-xs font-mono flex flex-wrap items-center gap-2">
          <span>Tracking task #{trackedTaskId}</span>
          {trackedTask && <StatusBadge status={trackedTask.status === "needs_approval" ? "pending_approval" : trackedTask.status} label={trackedTask.status === "needs_approval" ? "Needs review" : undefined} />}
          {!trackedTask && <span className="text-[var(--product-text-tertiary)]">Status updates when the list refreshes.</span>}
          <button
            type="button"
            onClick={() => selectTask(trackedTaskId)}
            className="px-2 py-0.5 rounded-lg bg-indigo-600 text-white font-semibold"
          >
            View task
          </button>
          <button
            type="button"
            onClick={() => setTrackedTaskId(null)}
            aria-label="Stop tracking this task"
            className="ml-auto text-[11px] opacity-75 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Main Split Studio Grid */}
      <JXGrid columns={12} gap="lg">
        {/* LEFT COLUMN: Tool Dispatch Studio (5 cols) */}
        <JXGridItem colSpan={5}>
          <JXCard className="bg-[var(--product-surface)]/70 border-[var(--product-line)] shadow-xl">
            <JXCardHeader
              title="Run a task"
              icon={<Zap className="w-4 h-4 text-indigo-400" />}
            />
            <JXCardContent>
              {/* UX-10: a real <form> — Enter submits, and the submit button
                  opens the confirm dialog (UX-04), never dispatches directly. */}
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  openDispatchConfirm();
                }}
              >
              {/* Target device */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="target-device-select" className="font-medium text-[var(--product-text-secondary)]">
                    Device
                  </label>
                </div>
                <select
                  id="target-device-select"
                  value={targetDeviceId}
                  onChange={(e) => setTargetDeviceId(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[var(--product-canvas)]/80 border border-[var(--product-line)] text-[var(--product-text-secondary)] font-mono text-xs focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors cursor-pointer"
                >
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.hostname} ({d.osRelease} • {d.status})
                    </option>
                  ))}
                </select>
              </div>

              {/* Tool Category & Selection */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="tool-select" className="font-medium text-[var(--product-text-secondary)]">
                    Tool
                  </label>
                  <span className={`font-mono text-[11px] px-2 py-0.5 rounded font-semibold uppercase ${getRiskBadgeColor(activeRiskTier)}`}>
                    {activeRiskTier.replace("_", " ")}
                  </span>
                </div>
                <select
                  id="tool-select"
                  value={selectedTool}
                  onChange={(e) => setSelectedTool(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[var(--product-canvas)]/80 border border-[var(--product-line)] text-[var(--product-text-secondary)] font-mono text-xs focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors cursor-pointer"
                >
                  <optgroup label="Vision & Input Primitives">
                    <option value="desktop_get_screenshot">desktop_get_screenshot [Tier 1: Safe ReadOnly]</option>
                    <option value="desktop_get_window_screenshot">desktop_get_window_screenshot [Tier 1: Safe ReadOnly]</option>
                    <option value="desktop_click">desktop_click [Tier 2: Workspace Edit]</option>
                    <option value="desktop_type">desktop_type [Tier 2: Workspace Edit]</option>
                  </optgroup>
                  <optgroup label="Terminal & Fleet Inspection">
                    <option value="run_shell">run_shell [Tier 3: Elevated Shell]</option>
                    <option value="list_devices">list_devices [Tier 1: Safe ReadOnly]</option>
                    <option value="get_device_status">get_device_status [Tier 1: Safe ReadOnly]</option>
                  </optgroup>
                  <optgroup label="File & System Operations">
                    <option value="read_file">read_file [Tier 1: Safe ReadOnly]</option>
                    <option value="write_file">write_file [Tier 2: Workspace Edit]</option>
                    <option value="apply_patch">apply_patch [Tier 2: Workspace Edit]</option>
                    <option value="get_system_info">get_system_info [Tier 1: Safe ReadOnly]</option>
                  </optgroup>
                </select>
                {/* UX-25: tier legend — the per-tool tier labels above mean:
                    Tier 1 read-only, Tier 2 workspace edits, Tier 3 elevated
                    shell, Tier 4 kernel. Compact one-liner + glossary. */}
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[11px] text-[var(--product-text-tertiary)]">
                  <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-400" />Tier 1 — read-only</span>
                  <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-indigo-400" />Tier 2 — workspace edits</span>
                  <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-400" />Tier 3 — elevated shell</span>
                  <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-rose-400" />Tier 4 — kernel</span>
                  <button type="button" onClick={() => setGlossaryOpen(true)} aria-label="Open glossary: what is a tier?"
                    className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--product-line)] font-semibold text-[var(--product-text-secondary)] hover:text-[var(--product-text)]"
                  >
                    ?
                  </button>
                </p>
                <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
              </div>

              {/* Parameter Presets Quick-Chips */}
              <div className="space-y-1.5">
                <span className="font-mono text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                  Parameter Presets
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => {
                    const isSelected = activePreset === p.name;
                    return (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-all ${
                          isSelected
                            ? "bg-indigo-600 text-white font-semibold shadow-md shadow-indigo-600/30"
                            : "bg-[var(--product-canvas)]/70 border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:border-[var(--product-line)] hover:text-[var(--product-text)]"
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* UX-39: run_shell gets a typed command form; raw JSON is an
                  advanced toggle. Other tools keep the JSON editor. */}
              {selectedTool === "run_shell" && !showRawJson ? (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label htmlFor="run-shell-command" className="block text-xs font-medium text-[var(--product-text-secondary)]">
                      Command
                    </label>
                    <textarea
                      id="run-shell-command"
                      rows={3}
                      value={typeof parsedArgs?.command === "string" ? parsedArgs.command : ""}
                      onChange={(e) => updateShellArg({ command: e.target.value })}
                      spellCheck={false}
                      placeholder="e.g. journalctl -u ai-bridge-agent -n 50"
                      className="w-full px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] font-mono text-xs leading-relaxed outline-none resize-none focus:border-indigo-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="run-shell-timeout" className="block text-xs font-medium text-[var(--product-text-secondary)]">
                      Timeout (seconds)
                    </label>
                    <input
                      id="run-shell-timeout"
                      type="number"
                      min={1}
                      max={3600}
                      value={typeof parsedArgs?.timeout_seconds === "number" ? parsedArgs.timeout_seconds : 30}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        updateShellArg({ timeout_seconds: Number.isFinite(n) ? Math.max(1, Math.min(3600, n)) : 30 });
                      }}
                      className="w-32 px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] font-mono text-xs outline-none focus:border-indigo-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRawJson(true)}
                    className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Advanced: edit raw JSON
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    {/* UX-19: associated label for the args textarea. */}
                    <label htmlFor="task-args-json" className="font-medium text-[var(--product-text-secondary)]">Task arguments (JSON)</label>
                    <div className="flex items-center gap-2">
                      {selectedTool === "run_shell" && (
                        <button
                          type="button"
                          onClick={() => setShowRawJson(false)}
                          className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          Use command form
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={beautifyJson}
                        className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        Format JSON
                      </button>
                      <span
                        className={`font-mono text-[11px] px-1.5 py-0.5 rounded font-semibold ${
                          jsonError
                            ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        }`}
                      >
                        {jsonError ? "Syntax Error" : "Valid JSON"}
                      </span>
                    </div>
                  </div>

                  <div className="relative rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] p-2 font-mono text-xs">
                    <textarea
                      id="task-args-json"
                      rows={7}
                      value={argsJson}
                      onChange={handleJsonChange}
                      spellCheck={false}
                      aria-invalid={Boolean(jsonError)}
                      aria-describedby={jsonError ? "task-args-error" : undefined}
                      className="w-full bg-transparent text-[var(--product-text-secondary)] font-mono text-xs leading-relaxed outline-none resize-none border-none p-1"
                    />
                  </div>
                  {jsonError && (
                    <p id="task-args-error" role="alert" className="text-[11px] font-mono text-rose-400 mt-1">{jsonError}</p>
                  )}
                </div>
              )}

              {/* Dispatch Action Button */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting || Boolean(jsonError)}
                  className={`w-full min-h-[44px] px-4 py-2.5 rounded-xl text-white font-semibold text-xs flex items-center justify-between transition-all shadow-lg ${
                    isSubmitting || jsonError
                      ? "bg-[var(--product-raised)] text-[var(--product-text-tertiary)] cursor-not-allowed border border-[var(--product-line)]"
                      : "bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] shadow-indigo-600/25"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isSubmitting ? (
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-300" />
                    ) : (
                      <Send className="w-4 h-4 text-indigo-200" />
                    )}
                    <span>{isSubmitting ? "Dispatching task..." : "Dispatch task to device"}</span>
                  </div>
                  <kbd className="font-mono text-[11px] px-2 py-0.5 rounded bg-black/30 text-indigo-200">
                    ⌘ + Enter
                  </kbd>
                </button>
              </div>

              {/* UX-34: recent dispatches — re-dispatch without re-selecting
                  device + tool + args. */}
              {recentDispatches.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-[var(--product-text-secondary)]">Recent dispatches</span>
                    <button
                      type="button"
                      onClick={() => {
                        setRecentDispatches([]);
                        try {
                          localStorage.removeItem(RECENT_DISPATCHES_KEY);
                        } catch {
                          // Storage unavailable; the in-memory list is cleared.
                        }
                      }}
                      className="text-[11px] font-mono text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                    >
                      Clear
                    </button>
                  </div>
                  <ul className="space-y-1.5">
                    {recentDispatches.map((entry) => {
                      const deviceName =
                        devices.find((d) => d.id === entry.deviceId)?.hostname || entry.deviceId;
                      const argsPreview = JSON.stringify(entry.args);
                      return (
                        <li
                          key={`${entry.dispatchedAt}-${entry.tool}-${entry.deviceId}`}
                          className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--product-canvas)]/70 border border-[var(--product-line)] text-xs font-mono"
                        >
                          <button
                            type="button"
                            onClick={() => loadRecentIntoForm(entry)}
                            title="Load this dispatch into the form"
                            className="min-w-0 flex-1 text-left truncate text-[var(--product-text-secondary)] hover:text-[var(--product-text)]"
                          >
                            <span className="font-semibold text-indigo-400">{entry.tool}</span>
                            <span className="text-[var(--product-text-tertiary)]"> on {deviceName} · </span>
                            <span className="text-[var(--product-text-tertiary)]">
                              {argsPreview.length > 60 ? `${argsPreview.slice(0, 60)}…` : argsPreview}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={() => redispatchRecent(entry)}
                            className="shrink-0 px-2 py-1 rounded-lg bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/30 font-semibold disabled:opacity-40"
                          >
                            Re-dispatch
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Security Guardrail Callout */}
              <div className="p-3 rounded-xl bg-[var(--product-canvas)]/70 border border-[var(--product-line)]/80 flex items-center justify-between text-[11px] font-mono text-[var(--product-text-tertiary)]">
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <Shield className="w-3.5 h-3.5" /> Zero-Trust Sandbox Active
                </span>
                <span>Signer: SecOps-CA-2026</span>
              </div>
              </form>
          </JXCardContent>
          </JXCard>
        </JXGridItem>

        {/* RIGHT COLUMN: Execution Queue Table & Vision Screen Inspector (7 cols) */}
        <JXGridItem colSpan={7}>
          <div className="space-y-6">
            {/* Upper: Execution Stream Table */}
            <JXCard className="bg-[var(--product-surface)]/70 border-[var(--product-line)] shadow-xl">
              <JXCardHeader
                title="Tasks"
                icon={<Layers className="w-4 h-4 text-cyan-400" />}
              />
              <JXCardContent>
              <div className="space-y-3">
                {isLive && (
                  <label className="flex items-center gap-2 text-xs text-[var(--product-text-secondary)]">
                    <input
                      type="checkbox"
                      checked={useServerHistory}
                      onChange={(e) => {
                        setUseServerHistory(e.target.checked);
                        setPage(1);
                      }}
                    />
                    Search full server history (paginated)
                  </label>
                )}
                {/* Status Filter Chips & Queue Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                  <div className="flex flex-wrap items-center gap-2">
                  {[
                    { id: "all", label: "All", count: useServerHistory ? historyTotal : tasks.length },
                    { id: "completed", label: "Completed", count: tasks.filter((t) => t.status === "completed").length },
                    { id: "running", label: "Running", count: tasks.filter((t) => t.status === "running").length },
                    { id: "needs_approval", label: "Needs Approval", count: tasks.filter((t) => t.status === "needs_approval").length },
                    { id: "failed", label: "Failed", count: tasks.filter((t) => t.status === "failed").length },
                  ].map((filter) => {
                    const isSelected = statusFilter === filter.id;
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        onClick={() => setStatusFilter(filter.id)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-mono flex items-center gap-1.5 transition-all ${
                          isSelected
                            ? "bg-indigo-600 text-white font-semibold shadow-md shadow-indigo-600/30"
                            : "bg-[var(--product-canvas)]/80 border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:border-[var(--product-line)]"
                        }`}
                      >
                        <span>{filter.label}</span>
                        <span className="px-1.5 py-0.2 rounded bg-black/30 text-[11px] font-bold">
                          {filter.count}
                        </span>
                      </button>
                    );
                  })}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void refreshLive?.()}
                      title="Refresh tasks"
                      className="px-2.5 py-1.5 rounded-xl bg-[var(--product-canvas)]/80 border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:text-[var(--product-text)] text-xs font-mono flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Refresh</span>
                    </button>
                    <button
                      type="button"
                      disabled={pendingAction === "clear"}
                      onClick={() => setClearConfirmOpen(true)}
                      title="Clear finished tasks"
                      className="px-2.5 py-1.5 rounded-xl bg-[var(--product-canvas)]/80 border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:text-rose-300 text-xs font-mono flex items-center gap-1.5 disabled:opacity-40"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{pendingAction === "clear" ? "Clearing..." : "Clear finished"}</span>
                    </button>
                  </div>
                </div>

                {/* Search & Device Filter */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="w-3.5 h-3.5 text-[var(--product-text-dim)] absolute left-3 top-2.5 pointer-events-none" />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search task ID, tool, or device..."
                      aria-label="Search tasks"
                      className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text)] placeholder:text-[var(--product-text-dim)]"
                    />
                  </div>
                  <select
                    value={deviceFilter}
                    onChange={(e) => setDeviceFilter(e.target.value)}
                    aria-label="Filter tasks by device"
                    className="px-3 py-1.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)]"
                  >
                    <option value="all">All devices</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>{d.hostname || d.name || d.id}</option>
                    ))}
                  </select>
                </div>

                {/* Task Table */}
                {historyError && useServerHistory && isLive ? (
                  <div role="alert" className="px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono flex items-center justify-between gap-2">
                    <span>Could not load server task history: {historyError}</span>
                    <button
                      type="button"
                      onClick={() => setHistoryReload((n) => n + 1)}
                      className="px-2.5 py-1 rounded-lg bg-rose-500/20 border border-rose-500/40 font-semibold shrink-0"
                    >
                      Retry
                    </button>
                  </div>
                ) : pagedTasks.length === 0 ? (
                  <EmptyState
                    variant="card"
                    title="No tasks match these filters"
                    description="Try a different status, device, or search — or dispatch a task to create one."
                    actionLabel="Clear filters"
                    onAction={() => {
                      setStatusFilter("all");
                      setDeviceFilter("all");
                      setSearchQuery("");
                      setPage(1);
                    }}
                  />
                ) : (
                <div className="overflow-x-auto rounded-xl border border-[var(--product-line)]/80 bg-[var(--product-canvas)]/60">
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">Task queue: one row per dispatched task, with its device, tool, status, and actions</caption>
                    <thead>
                      <tr className="bg-[var(--product-surface)]/80 text-[var(--product-text-tertiary)] font-mono text-[11px] uppercase border-b border-[var(--product-line)]">
                        <th scope="col" className="py-2.5 px-3">Task ID</th>
                        <th scope="col" className="py-2.5 px-3">Target &amp; Tool</th>
                        <th scope="col" className="py-2.5 px-3">Status</th>
                        <th scope="col" className="py-2.5 px-3">Invoker</th>
                        <th scope="col" className="py-2.5 px-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--product-line)]/60 font-mono">
                      {pagedTasks.map((t) => {
                        const isSelected = selectedTaskId === t.id;
                        const canCancel = t.status === "pending" || t.status === "running" || t.status === "needs_approval" || (t.status as string) === "queued";
                        const approval = findApprovalForTask(t);
                        return (
                          <tr
                            key={t.id}
                            id={`task-row-${t.id}`}
                            onClick={() => selectTask(t.id)}
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? "bg-indigo-950/40 text-[var(--product-text)]"
                                : "hover:bg-[var(--product-surface)]/40 text-[var(--product-text-secondary)]"
                            }`}
                          >
                            <td className="py-2.5 px-3">
                              <span className="font-semibold text-indigo-400">#{t.id}</span>
                            </td>
                            <td className="py-2.5 px-3">
                              <div className="flex flex-col">
                                <span className="font-semibold text-[var(--product-text-secondary)]">{t.tool}</span>
                                <span className="text-[11px] text-[var(--product-text-tertiary)]">{t.deviceHostname || t.deviceId}</span>
                              </div>
                            </td>
                            <td className="py-2.5 px-3">
                              {/* UX-05: shared StatusBadge; UX-09: the matching
                                  approval id/status inline, linked to Approvals. */}
                              <div className="flex flex-col gap-1">
                                <StatusBadge
                                  status={t.status === "needs_approval" ? "pending_approval" : t.status}
                                  label={t.status === "needs_approval" ? "Needs review" : undefined}
                                />
                                {approval && (
                                  <a
                                    href="#human-approvals"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-[11px] text-indigo-400 hover:text-indigo-300 underline"
                                  >
                                    Approval {approval.id} · {approval.status}
                                  </a>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-[var(--product-text-tertiary)] text-[11px]">{t.invoker}</td>
                            <td className="py-2.5 px-3 text-right">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                {t.status === "needs_approval" && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={pendingAction === `decide:${t.id}`}
                                      onClick={(e) => void handleDecideTask(t, "approved", e)}
                                      title="Approve task"
                                      className="px-2 py-1 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                                    >
                                      <CheckCircle2 className="w-3 h-3" />
                                      <span>Approve</span>
                                    </button>
                                    <button
                                      type="button"
                                      disabled={pendingAction === `decide:${t.id}`}
                                      onClick={(e) => void handleDecideTask(t, "denied", e)}
                                      title="Deny task"
                                      className="px-2 py-1 rounded-lg bg-rose-600/20 border border-rose-500/40 text-rose-300 hover:bg-rose-600/30 text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                                    >
                                      <XCircle className="w-3 h-3" />
                                      <span>Deny</span>
                                    </button>
                                  </>
                                )}
                                {canCancel && (
                                  <button
                                    type="button"
                                    disabled={pendingAction === `cancel:${t.id}`}
                                    onClick={(e) => void handleCancelTask(t.id, e)}
                                    title="Cancel task"
                                    className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
                                  >
                                    <Ban className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {(t.status === "failed" || t.status === "cancelled" || t.status === "completed") && (
                                  <button
                                    type="button"
                                    disabled={pendingAction === `retry:${t.id}`}
                                    onClick={(e) => void handleRetryTask(t, e)}
                                    title="Retry / Re-queue task"
                                    className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 disabled:opacity-40"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => openEditTask(t, e)}
                                  title="Edit task tool/args"
                                  className="p-1.5 rounded-lg bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:text-[var(--product-text)]"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={pendingAction === `delete:${t.id}`}
                                  onClick={(e) => requestDeleteTask(t.id, e)}
                                  title="Delete task"
                                  className="p-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => selectTask(t.id)}
                                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                                    isSelected
                                      ? "bg-indigo-600 text-white"
                                      : "bg-[var(--product-raised)] text-[var(--product-text-secondary)] hover:bg-[var(--product-raised)]"
                                  }`}
                                >
                                  View
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                )}

                {totalPages > 1 && (
                  <div className="flex items-center justify-between text-xs font-mono text-[var(--product-text-tertiary)] pt-1">
                    <span>Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredTasks.length)} of {filteredTasks.length}</span>
                    <div className="flex items-center gap-2">
                      <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-2.5 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] disabled:opacity-40">Prev</button>
                      <span>Page {safePage} / {totalPages}</span>
                      <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="px-2.5 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] disabled:opacity-40">Next</button>
                    </div>
                  </div>
                )}
              </div>
            </JXCardContent>
            </JXCard>

            {/* Lower: Vision Screen Viewer & Output Inspector */}
            <JXCard className="bg-[var(--product-surface)]/70 border-[var(--product-line)] shadow-xl">
              <JXCardHeader
                title={`Vision Inspector — #${activeTask?.id || "N/A"}`}
                icon={<Crosshair className="w-4 h-4 text-emerald-400" />}
              />
              <JXCardContent>
              {/* UX-13/UX-27: a deep-linked task id that matches nothing
                  renders an explicit state instead of the first task. */}
              {taskNotFound ? (
                <EmptyState
                  variant="card"
                  title="Task not available"
                  description={`The task “${routeTaskId}” is not in the current task list. The link may be stale, or the task may have been deleted.`}
                  actionLabel="Show all tasks"
                  onAction={() => {
                    resolvedRouteTaskRef.current = null;
                    setRouteTaskId(null);
                    setTaskNotFound(false);
                    setLinkedTask(null);
                    setSelectedTaskId(tasks[0]?.id ?? "");
                    updateRouteParams({ task: undefined });
                  }}
                />
              ) : (
              <div className="space-y-4">
                {/* Control bar: Zoom, SoM toggle, Task actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 p-2 rounded-xl bg-[var(--product-canvas)]/80 border border-[var(--product-line)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-indigo-400">
                      {activeTask?.tool}
                    </span>
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                      {activeTask?.deviceHostname || activeTask?.deviceId}
                    </span>
                    {activeTask?.status === "needs_approval" && (
                      <>
                        <button
                          type="button"
                          disabled={pendingAction === `decide:${activeTask.id}`}
                          onClick={() => void handleDecideTask(activeTask, "approved")}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 text-xs font-mono font-semibold flex items-center gap-1 disabled:opacity-40"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Approve</span>
                        </button>
                        <button
                          type="button"
                          disabled={pendingAction === `decide:${activeTask.id}`}
                          onClick={() => void handleDecideTask(activeTask, "denied")}
                          className="px-2.5 py-1 rounded-lg bg-rose-600/20 border border-rose-500/40 text-rose-300 hover:bg-rose-600/30 text-xs font-mono font-semibold flex items-center gap-1 disabled:opacity-40"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Deny</span>
                        </button>
                      </>
                    )}
                    {activeTask && (activeTask.status === "pending" || activeTask.status === "running" || activeTask.status === "needs_approval" || (activeTask.status as string) === "queued") && (
                      <button
                        type="button"
                        disabled={pendingAction === `cancel:${activeTask.id}`}
                        onClick={() => void handleCancelTask(activeTask.id)}
                        className="px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 text-xs font-mono font-semibold flex items-center gap-1 disabled:opacity-40"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Cancel</span>
                      </button>
                    )}
                    {activeTask && (activeTask.status === "failed" || activeTask.status === "cancelled" || activeTask.status === "completed") && (
                      <button
                        type="button"
                        disabled={pendingAction === `retry:${activeTask.id}`}
                        onClick={() => void handleRetryTask(activeTask)}
                        className="px-2.5 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 text-xs font-mono font-semibold flex items-center gap-1 disabled:opacity-40"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Retry</span>
                      </button>
                    )}
                    {activeTask && (
                      <button
                        type="button"
                        onClick={() => openEditTask(activeTask)}
                        className="px-2.5 py-1 rounded-lg bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:text-[var(--product-text)] text-xs font-mono font-semibold flex items-center gap-1"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
                    )}
                    {activeTask && (
                      <button
                        type="button"
                        disabled={pendingAction === `delete:${activeTask.id}`}
                        onClick={() => requestDeleteTask(activeTask.id)}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 text-xs font-mono font-semibold flex items-center gap-1 disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={pendingAction === "capture"}
                      onClick={() => void handleCaptureLiveScreenshot()}
                      className="px-3 py-1 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-600/30 disabled:opacity-40"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>Capture Live</span>
                    </button>
                    {/* SoM Toggle */}
                    <button
                      type="button"
                      onClick={() => setSomEnabled(!somEnabled)}
                      className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all ${
                        somEnabled
                          ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/40"
                          : "bg-[var(--product-raised)] text-[var(--product-text-tertiary)] border border-[var(--product-line)]"
                      }`}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                      <span>SoM Overlay: {somEnabled ? "ON" : "OFF"}</span>
                    </button>

                    {/* Zoom Buttons */}
                    <div className="flex items-center rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)] p-0.5">
                      <button
                        type="button"
                        onClick={handleZoomOut}
                        title="Zoom Out"
                        aria-label="Zoom out"
                        className="p-1.5 text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] transition-colors"
                      >
                        <ZoomOut className="w-3.5 h-3.5" />
                      </button>
                      <span className="font-mono text-[11px] px-2 text-[var(--product-text-secondary)] tabular-nums">
                        {Math.round(zoomLevel * 100)}%
                      </span>
                      <button
                        type="button"
                        onClick={handleZoomIn}
                        title="Zoom In"
                        aria-label="Zoom in"
                        className="p-1.5 text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] transition-colors"
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={handleZoomReset}
                        title="Reset Zoom"
                        aria-label="Reset zoom to fit"
                        className="px-2 py-0.5 font-mono text-[11px] text-indigo-400 hover:text-indigo-300"
                      >
                        Fit
                      </button>
                    </div>
                  </div>
                </div>

                {/* Vision Screen Canvas (Live captured frame when available, demo canvas otherwise) */}
                <div className="relative w-full aspect-video rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] overflow-hidden select-none">
                  {liveScreenshotDataUrl ? (
                    <img
                      src={liveScreenshotDataUrl}
                      alt={`Desktop frame for ${activeTask?.deviceHostname || activeTask?.deviceId || targetDeviceId}`}
                      className="h-full w-full object-contain bg-black"
                    />
                  ) : (
                  <div className="absolute inset-0 flex flex-col bg-[var(--product-canvas)]">
                    {/* D-04: this canvas is a placeholder, not a real desktop.
                        Label it prominently whenever no live frame exists. */}
                    <div className="shrink-0 bg-amber-500/15 border-b border-amber-500/40 px-3 py-2 text-[11px] font-mono font-bold text-amber-300" role="note">
                      SIMULATED — no live frame. This is a placeholder desktop, not a real device screen.
                    </div>
                    {/* Top Simulated OS Bar */}
                    <div className="h-6 w-full bg-[var(--product-surface)] border-b border-[var(--product-line)] px-3 flex items-center justify-between font-mono text-[11px] text-[var(--product-text-tertiary)]">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--product-text-secondary)]">Ubuntu 24.04 LTS</span>
                        <span>{activeTask?.deviceHostname || "srv-us-east-412"}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span>CPU 18%</span>
                        <span>RAM 12.4GB</span>
                        <span>14:38:09 UTC</span>
                      </div>
                    </div>

                    {/* Window Area */}
                    <div className="flex-1 p-3 grid grid-cols-12 gap-3 relative overflow-hidden">
                      {/* Simulated Window 1: Terminal */}
                      <div className="col-span-12 sm:col-span-7 rounded-lg bg-[var(--product-surface)]/95 border border-[var(--product-line)] p-2.5 font-mono text-xs flex flex-col relative shadow-lg">
                        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--product-line)]/80 mb-2">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80"></span>
                            <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></span>
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></span>
                            <span className="ml-2 text-[11px] text-[var(--product-text-tertiary)]">bash — 80x24</span>
                          </div>
                        </div>
                        <div className="space-y-1 text-[var(--product-text-secondary)] text-[11px]">
                          <p><span className="text-emerald-400">root@srv-us-east-412:~#</span> systemctl status ai-bridge-agent</p>
                          <p className="text-emerald-400">● ai-bridge-agent.service - Active (running)</p>
                          <p className="text-[var(--product-text-tertiary)]">Main PID: 18492 (agent_worker)</p>
                          <p className="text-cyan-300">WebSocket channel: verified (TLS 1.3)</p>
                        </div>
                      </div>

                      {/* Simulated Window 2: Web Preview */}
                      <div className="col-span-12 sm:col-span-5 rounded-lg bg-[var(--product-surface)]/90 border border-[var(--product-line)] p-2.5 flex flex-col relative shadow-lg">
                        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--product-line)]/80 mb-2 text-[11px] text-[var(--product-text-tertiary)] font-mono">
                          <span>Bridge Gateway Inspector</span>
                          <span className="text-amber-400">● Simulated</span>
                        </div>
                        <div className="flex-1 flex flex-col justify-end gap-1">
                          <div className="h-14 w-full flex items-end gap-1 px-1">
                            <div className="flex-1 bg-indigo-500/40 rounded-t h-[40%]"></div>
                            <div className="flex-1 bg-indigo-500/60 rounded-t h-[65%]"></div>
                            <div className="flex-1 bg-indigo-500/80 rounded-t h-[85%]"></div>
                            <div className="flex-1 bg-cyan-400 rounded-t h-[95%]"></div>
                          </div>
                          <span className="font-mono text-[11px] text-[var(--product-text-dim)] text-center">Packets/Sec</span>
                        </div>
                      </div>

                      {/* Bottom Taskbar */}
                      <div className="col-span-12 h-8 rounded-lg bg-[var(--product-surface)]/90 border border-[var(--product-line)] flex items-center justify-between px-3 text-[11px] font-mono text-[var(--product-text-tertiary)]">
                        <div className="flex items-center gap-3">
                          <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                          <Monitor className="w-3.5 h-3.5 text-emerald-400" />
                          <FileText className="w-3.5 h-3.5 text-[var(--product-text-tertiary)]" />
                        </div>
                        <span>IPC Channel: OK • 14ms</span>
                      </div>
                    </div>
                  </div>
                  )}

                  {/* Set-of-Marks (SoM) Bounding Boxes Overlay */}
                  {somEnabled && (
                    <div className="absolute inset-0 pointer-events-none">
                      {DEFAULT_SOM_MARKS.map((mark) => (
                        <div
                          key={mark.id}
                          onClick={() => setSelectedMarkId(mark.id)}
                          className={`absolute border-2 rounded-lg pointer-events-auto cursor-pointer transition-all ${mark.color} ${mark.positionClass} ${
                            selectedMarkId === mark.id ? "ring-2 ring-white shadow-xl scale-[1.01]" : ""
                          }`}
                        >
                          <span className="absolute -top-3 -left-1 px-1.5 py-0.2 rounded text-[11px] font-mono font-bold bg-[var(--product-surface)] text-white shadow-md border border-[var(--product-line)]">
                            [{mark.id}]
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Bottom Telemetry Overlay Inside Canvas */}
                  <div className="absolute bottom-2 left-2 right-2 px-3 py-1.5 rounded-lg bg-[var(--product-canvas)]/85 backdrop-blur-md border border-[var(--product-line)] flex items-center justify-between font-mono text-[11px] text-[var(--product-text-tertiary)]">
                    <span className="text-emerald-400 flex items-center gap-1.5">
                      <Crosshair className="w-3.5 h-3.5" />
                      {liveScreenshotDataUrl
                        ? "4 Target Marks Bound (SoM Alpha 1.4)"
                        : "4 Simulated Marks — placeholder positions, no live frame"}
                    </span>
                    <span className="tabular-nums">{liveScreenshotDataUrl ? "3840×2160 native (DPI: 2.0)" : "No live frame"}</span>
                  </div>
                </div>

                {/* Mark Details Inspection if a mark is selected */}
                {selectedMarkId && (
                  <div className="p-3 rounded-xl bg-[var(--product-canvas)]/90 border border-indigo-500/40 text-xs font-mono space-y-1">
                    <div className="flex items-center justify-between text-indigo-300 font-bold">
                      <span>Selected SoM Mark [{selectedMarkId}]</span>
                      <button
                        type="button"
                        onClick={() => setSelectedMarkId(null)}
                        className="text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                      >
                        Dismiss
                      </button>
                    </div>
                    {(() => {
                      const m = DEFAULT_SOM_MARKS.find((mark) => mark.id === selectedMarkId);
                      if (!m) return null;
                      return (
                        <div className="text-[var(--product-text-secondary)] space-y-0.5">
                          <div>Label: {m.label}</div>
                          <div>Category: {m.category}</div>
                          <div>Bounding Box: [X: {m.bounds[0]}%, Y: {m.bounds[1]}%, W: {m.bounds[2]}%, H: {m.bounds[3]}%]</div>
                          {!liveScreenshotDataUrl && (
                            <div className="text-amber-300">Simulated mark — placeholder position, no live frame.</div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Execution Return Payload Drawer */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--product-text-secondary)]">Execution Return Payload</span>
                      <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        200 OK
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={copyToClipboard}
                      className="px-2.5 py-1 rounded-lg bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] font-mono text-[11px] flex items-center gap-1.5 transition-colors"
                    >
                      {copiedPayload ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-[var(--product-text-tertiary)]" />
                          <span>Copy JSON</span>
                        </>
                      )}
                    </button>
                  </div>

                  <pre tabIndex={0} aria-label="Task output" className="p-3 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] font-mono text-xs text-[var(--product-text-secondary)] overflow-x-auto max-h-36">
                    <code>
                      {JSON.stringify(
                        activeTask?.result
                          ? {
                              status: activeTask.status,
                              taskId: activeTask.id,
                              tool: activeTask.tool,
                              targetDevice: activeTask.deviceHostname || activeTask.deviceId,
                              args: activeTask.args,
                              result: activeTask.result,
                            }
                          : {
                              status: activeTask?.status || "pending",
                              taskId: activeTask?.id,
                              tool: activeTask?.tool,
                              targetDevice: activeTask?.deviceHostname || activeTask?.deviceId,
                              args: activeTask?.args || {},
                            },
                        null,
                        2
                      )}
                    </code>
                  </pre>
                </div>
              </div>
              )}
            </JXCardContent>
            </JXCard>
          </div>
        </JXGridItem>
      </JXGrid>

      {editingTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Edit task">
          <div className="w-full max-w-lg rounded-2xl bg-[var(--product-surface)] border border-[var(--product-line)] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--product-text)] font-mono">Edit Task #{editingTask.id}</h3>
              <button type="button" onClick={() => setEditingTask(null)} className="text-xs font-mono text-[var(--product-text-tertiary)]">Close</button>
            </div>
            {editError && <div role="alert" className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">{editError}</div>}
            <div className="space-y-3">
              <div>
                <label htmlFor="edit-task-tool" className="block text-xs font-mono text-[var(--product-text-tertiary)] mb-1">Tool</label>
                <input id="edit-task-tool" value={editTool} onChange={(e) => setEditTool(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text)]" />
              </div>
              <div>
                <label htmlFor="edit-task-args" className="block text-xs font-mono text-[var(--product-text-tertiary)] mb-1">Arguments (JSON)</label>
                <textarea id="edit-task-args" rows={6} value={editArgsJson} onChange={(e) => setEditArgsJson(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text)]" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingTask(null)} className="px-3 py-1.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)]">Cancel</button>
              <button type="button" onClick={() => void handleSaveTaskEdit()} className="px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-mono font-semibold">Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* UX-04: dispatch confirmation. Tier 3/4 uses hold-to-confirm;
          the dialog shows device, tool, tier, and a truncated args preview.
          The dispatch itself runs only in confirmDispatch. */}
      <ConfirmDestructive
        open={dispatchDraft !== null}
        title="Dispatch task?"
        objectName={
          dispatchDraft
            ? `${dispatchDraft.tool} on ${
                devices.find((d) => d.id === dispatchDraft.deviceId)?.hostname ||
                dispatchDraft.deviceId
              }`
            : undefined
        }
        consequence={
          dispatchDraft
            ? `This dispatches ${dispatchDraft.tool} (${dispatchDraft.riskTier.replace("_", " ")}) to the selected device with these arguments: ${
                JSON.stringify(dispatchDraft.args).length > 300
                  ? `${JSON.stringify(dispatchDraft.args).slice(0, 300)}…`
                  : JSON.stringify(dispatchDraft.args)
              }`
            : ""
        }
        confirmLabel={
          dispatchDraft && (dispatchDraft.riskTier === "tier3_shell" || dispatchDraft.riskTier === "tier4_kernel")
            ? "Hold to dispatch"
            : "Dispatch task"
        }
        requireHold={
          !!dispatchDraft &&
          (dispatchDraft.riskTier === "tier3_shell" || dispatchDraft.riskTier === "tier4_kernel")
        }
        tone={
          dispatchDraft && (dispatchDraft.riskTier === "tier3_shell" || dispatchDraft.riskTier === "tier4_kernel")
            ? "error"
            : "warning"
        }
        onConfirm={() => void confirmDispatch()}
        onCancel={() => setDispatchDraft(null)}
      />

      {/* UX-03: delete-task confirmation. */}
      <ConfirmDestructive
        open={deleteTarget !== null}
        title="Delete task?"
        objectName={deleteTarget ? `Task #${deleteTarget}` : undefined}
        consequence="This permanently deletes the task record. The task cannot be recovered, and its result and history entry are gone."
        confirmLabel="Delete task"
        onConfirm={() => void confirmDeleteTask()}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* UX-03: clear-tasks confirmation (bulk delete of the filtered set). */}
      <ConfirmDestructive
        open={clearConfirmOpen}
        title="Clear tasks?"
        objectName={
          statusFilter === "all"
            ? "All tasks in this list"
            : `Tasks with status “${statusFilter}”`
        }
        consequence={`This permanently deletes ${clearScopeCount} task(s) matching the current filter. Deleted tasks cannot be recovered.`}
        confirmLabel="Clear tasks"
        onConfirm={() => void confirmClearTasks()}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
};

export default TaskQueueVisionView;
