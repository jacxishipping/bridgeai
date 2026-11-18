/**
 * Autonomous Workflows — live mode talks to the real control plane
 * (/api/workflows*, /api/ai/tools). Demo mode (not signed in) renders the seeded
 * preview from WorkflowsDemoView, which is the only place fixtures live.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Workflow, Plus, Search, RefreshCw, StopCircle, AlertTriangle, Copy, Check, Trash2, RotateCcw, BookmarkPlus, Clock } from "lucide-react";
import { api, token, sessionToken } from "../api";
import { ConfirmDestructive, EmptyState, GlassModal, StatusBadge } from "../ui";
import { Freshness } from "../components/Freshness";
import { useDashboardStore } from "../state/dashboardStore";
import { readRoute, updateRouteParams } from "../state/navigation";
import { pushNotice } from "../state/notices";
import WorkflowsDemoView from "./WorkflowsDemoView";

interface WfStepDef { name?: string; action: string; args?: Record<string, unknown>; verify?: { text: string; timeout_seconds?: number }; retries?: number }
interface WfStepResult {
  index: number; name: string; action: string; args?: Record<string, unknown>;
  status: "running" | "completed" | "failed"; duration_seconds?: number;
  result?: unknown; error?: string | null; verification?: unknown;
}
interface Wf {
  id: string; name: string; device_id?: string | null; status: string;
  current_step: number; total_steps: number; steps: WfStepDef[]; results: WfStepResult[];
  error?: string | null; created_at?: number; updated_at?: number; completed_at?: number | null;
}
interface Template { id: string; name: string; description?: string; steps: WfStepDef[]; custom?: boolean }
interface ToolSpec { name: string; description?: string; category?: string; tier?: number; parameters?: any }
interface DraftStep { name: string; action: string; args: string; verifyText: string }

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const FILTERS = ["all", "running", "completed", "failed", "cancelled"] as const;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Request failed.";
}
function normalize(raw: any): Wf {
  return {
    ...raw,
    id: raw.id ?? raw.workflow_id,
    name: raw.name || raw.id,
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    results: Array.isArray(raw.results) ? raw.results : [],
    current_step: Number(raw.current_step || 0),
    total_steps: Number(raw.total_steps || (raw.steps?.length ?? 0)),
  };
}
function fmtTime(ts?: number | null) {
  if (!ts) return "—";
  return new Date(ts * (ts < 1e12 ? 1000 : 1)).toLocaleString();
}
const draftFromDef = (s: WfStepDef): DraftStep => ({
  name: s.name || "",
  action: s.action,
  args: JSON.stringify(s.args || {}, null, 2),
  verifyText: s.verify?.text || "",
});

function WorkflowsLive() {
  const [workflows, setWorkflows] = useState<Wf[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [workflowSchedules, setWorkflowSchedules] = useState<any[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // UX-13: workflow deep link (?workflow=<id>). The id from the hash is
  // the initial selection; an unknown id renders an explicit "Workflow not
  // available" state instead of silently selecting the first workflow.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readRoute().workflow ?? null
  );
  const [routeWorkflowId, setRouteWorkflowId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readRoute().workflow ?? null
  );
  const [workflowNotFound, setWorkflowNotFound] = useState<boolean>(false);
  // A deep-linked id is resolved once; afterwards the user's own selection
  // wins and list refreshes must not re-select or re-scroll.
  const resolvedRouteWorkflowRef = useRef<string | null>(null);
  // UX-13: selecting a workflow writes ?workflow=<id> back to the hash.
  const selectWorkflow = useCallback((id: string) => {
    resolvedRouteWorkflowRef.current = id;
    setRouteWorkflowId(id);
    setSelectedId(id);
    setSelectedStep(1);
    setWorkflowNotFound(false);
    updateRouteParams({ workflow: id });
  }, []);
  const [selectedStep, setSelectedStep] = useState(1);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [query, setQuery] = useState("");
  const [streamMode, setStreamMode] = useState<"stream" | "polling" | "idle">("idle");
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // UX-03/UX-22: one pending destructive confirmation; the action only runs
  // from ConfirmDestructive.
  const [deleteConfirm, setDeleteConfirm] = useState<{
    title: string; objectName?: string; consequence: string; confirmLabel: string;
    run: () => void | Promise<void>;
  } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState(3600);
  // UX-06: live sync state surfaced via Freshness in the header.
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);

  const [builderOpen, setBuilderOpen] = useState(false);
  const [name, setName] = useState("");
  const [deviceId, setDeviceId] = useState("local");
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [maxRetries, setMaxRetries] = useState(1);
  const [requireStepApproval, setRequireStepApproval] = useState(false);
  const [draft, setDraft] = useState<DraftStep[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);

  const upsert = useCallback((wf: Wf) => {
    setWorkflows((prev) => {
      const i = prev.findIndex((w) => w.id === wf.id);
      if (i < 0) return [wf, ...prev];
      const next = prev.slice();
      next[i] = { ...prev[i], ...wf };
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    // UX-13: a manual refresh re-resolves the ?workflow= deep link, so a
    // workflow created since the link was opened can now be found.
    resolvedRouteWorkflowRef.current = null;
    setLoading(true);
    setLoadError(null);
    const [wfs, tpls, tl, devs, scheds] = await Promise.allSettled([
      api.workflows(), api.workflowTemplates(), api.aiTools("raw"), api.devices(), api.schedules(),
    ]);
    if (wfs.status === "fulfilled") {
      const list = (Array.isArray(wfs.value) ? wfs.value : []).map(normalize);
      setWorkflows(list);
      setSelectedId((cur) => (cur && list.some((w) => w.id === cur) ? cur : list[0]?.id ?? null));
    } else {
      setLoadError(errMsg(wfs.reason));
    }
    if (tpls.status === "fulfilled") setTemplates(tpls.value?.templates || []);
    if (tl.status === "fulfilled") setTools(Array.isArray(tl.value?.tools) ? tl.value.tools : []);
    if (devs.status === "fulfilled") setDevices(Array.isArray(devs.value) ? devs.value : devs.value?.devices || []);
    if (scheds.status === "fulfilled") {
      const list = Array.isArray(scheds.value) ? scheds.value : [];
      setWorkflowSchedules(list.filter((s: any) => s.tool === "__workflow__"));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // UX-13: resolve the ?workflow= deep link once the list has loaded.
  // Found → select it and scroll to its row; loaded but absent → an
  // explicit "Workflow not available" state (never the first workflow).
  // A failed load cannot prove absence, so it declares nothing.
  useEffect(() => {
    if (!routeWorkflowId || resolvedRouteWorkflowRef.current === routeWorkflowId) return;
    if (loading || loadError) return;
    if (workflows.some((w) => w.id === routeWorkflowId)) {
      resolvedRouteWorkflowRef.current = routeWorkflowId;
      setSelectedId(routeWorkflowId);
      setSelectedStep(1);
      setWorkflowNotFound(false);
      requestAnimationFrame(() => {
        document.getElementById(`workflow-row-${routeWorkflowId}`)?.scrollIntoView({ block: "nearest" });
      });
    } else {
      resolvedRouteWorkflowRef.current = routeWorkflowId;
      // Clear the selection: refresh() may have defaulted to the first
      // workflow, which must not stand in for the linked one (UX-27).
      setSelectedId(null);
      setWorkflowNotFound(true);
    }
  }, [workflows, loading, loadError, routeWorkflowId]);

  const selected = useMemo(() => workflows.find((w) => w.id === selectedId) || null, [workflows, selectedId]);
  const selectedActive = !!selected && !TERMINAL.has(selected.status);

  // Live progress: authenticated fetch stream (EventSource cannot send auth headers), polling fallback.
  const activeId = selectedActive ? selected!.id : null;
  useEffect(() => {
    if (!activeId) { setStreamMode("idle"); return; }
    let stopped = false;
    const ctrl = new AbortController();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (stopped || pollTimer) return;
      setStreamMode("polling");
      pollTimer = setInterval(async () => {
        try {
          const wf = normalize(await api.workflowDetail(activeId));
          if (!stopped) upsert(wf);
          if (TERMINAL.has(wf.status) && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        } catch { /* keep polling */ }
      }, 2000);
    };

    (async () => {
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        const st = sessionToken(); const at = token();
        if (st) headers["X-Session-Token"] = st; else if (at) headers["X-Admin-Token"] = at;
        const res = await fetch(api.streamWorkflowUrl(activeId), { headers, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setStreamMode("stream");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const p = JSON.parse(line.slice(5).trim());
              upsert({
                id: p.workflow_id, status: p.status, current_step: p.current_step,
                total_steps: p.total_steps, results: p.results || [], error: p.error,
              } as Wf);
            } catch { /* ignore malformed frame */ }
          }
        }
        if (!stopped) {
          // Stream ended: confirm final state from the server (falls back to polling if still active).
          const wf = normalize(await api.workflowDetail(activeId));
          upsert(wf);
          if (!TERMINAL.has(wf.status)) startPolling(); else setStreamMode("idle");
        }
      } catch {
        if (!stopped) startPolling();
      }
    })();

    return () => { stopped = true; ctrl.abort(); if (pollTimer) clearInterval(pollTimer); };
  }, [activeId, upsert]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((w) =>
      (filter === "all" || w.status === filter) &&
      (!q || w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q) ||
        (w.device_id || "").toLowerCase().includes(q) ||
        w.steps.some((s) => s.action.toLowerCase().includes(q))));
  }, [workflows, filter, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: workflows.length };
    for (const w of workflows) c[w.status] = (c[w.status] || 0) + 1;
    return c;
  }, [workflows]);

  const toolMap = useMemo(() => new Map(tools.map((t) => [t.name, t])), [tools]);

  const stepRows = useMemo(() => {
    if (!selected) return [];
    const n = Math.max(selected.total_steps, selected.steps.length);
    return Array.from({ length: n }, (_, i) => {
      const def = selected.steps[i];
      const res = selected.results.find((r) => r.index === i + 1);
      const status = res?.status || (selected.status === "cancelled" ? "cancelled" : selected.current_step === i + 1 && selectedActive ? "running" : "pending");
      return {
        number: i + 1,
        name: res?.name || def?.name || `Step ${i + 1}`,
        action: res?.action || def?.action || "",
        args: res?.args || def?.args || {},
        status, res,
      };
    });
  }, [selected, selectedActive]);
  const activeStep = stepRows.find((s) => s.number === selectedStep) || stepRows[0];

  const cancel = async () => {
    if (!selected) return;
    setCancelling(true);
    try {
      await api.cancelWorkflow(selected.id);
      upsert(normalize(await api.workflowDetail(selected.id)));
      pushNotice({ tone: "success", title: `Workflow ${selected.id} cancelled.` });
    } catch (e) {
      pushNotice({ tone: "error", title: "Cancel failed", message: errMsg(e) });
    } finally { setCancelling(false); }
  };

  const retry = async (fromFailedStep: boolean) => {
    if (!selected) return;
    try {
      await api.retryWorkflow(selected.id, fromFailedStep);
      upsert(normalize(await api.workflowDetail(selected.id)));
      pushNotice({ tone: "success", title: fromFailedStep ? `Resuming workflow ${selected.id} from failed step.` : `Re-running workflow ${selected.id}.` });
    } catch (e) {
      pushNotice({ tone: "error", title: "Retry failed", message: errMsg(e) });
    }
  };

  const remove = () => {
    if (!selected) return;
    const wf = selected;
    setDeleteConfirm({
      title: "Delete workflow",
      objectName: `${wf.name} (${wf.id})`,
      consequence: "This permanently deletes the workflow and its recorded steps and results. It cannot be restored.",
      confirmLabel: "Delete workflow",
      run: async () => {
        try {
          await api.deleteWorkflow(wf.id);
          setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
          setSelectedId("");
          pushNotice({ tone: "success", title: `Workflow ${wf.id} deleted.` });
        } catch (e) {
          pushNotice({ tone: "error", title: "Delete failed", message: errMsg(e) });
        }
      },
    });
  };

  const saveAsTemplate = async () => {
    if (!selected) return;
    try {
      await api.createWorkflowTemplate({ name: selected.name, description: `Saved from ${selected.id}`, steps: selected.steps });
      pushNotice({ tone: "success", title: `Saved "${selected.name}" as a reusable template.` });
      void refresh();
    } catch (e) {
      pushNotice({ tone: "error", title: "Save template failed", message: errMsg(e) });
    }
  };

  const removeTemplate = (tplId: string, tplName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConfirm({
      title: "Delete workflow template",
      objectName: tplName,
      consequence: "This permanently deletes the custom template. Workflows already created from it are kept.",
      confirmLabel: "Delete template",
      run: async () => {
        try {
          await api.deleteWorkflowTemplate(tplId);
          setTemplates((prev) => prev.filter((t) => t.id !== tplId));
          pushNotice({ tone: "success", title: "Custom template deleted." });
        } catch (e2) {
          pushNotice({ tone: "error", title: "Delete template failed", message: errMsg(e2) });
        }
      },
    });
  };

  const scheduleRun = () => {
    if (!selected) return;
    setScheduleInterval(3600);
    setScheduleOpen(true);
  };

  const confirmScheduleRun = async () => {
    if (!selected) return;
    const interval = Math.max(60, Number(scheduleInterval) || 3600);
    setScheduleOpen(false);
    try {
      await api.scheduleWorkflow(selected.id, { interval_seconds: interval });
      pushNotice({ tone: "success", title: `Scheduled "${selected.name}" every ${interval}s.` });
    } catch (e) {
      pushNotice({ tone: "error", title: "Schedule failed", message: errMsg(e) });
    }
  };

  const openBuilder = (tpl?: Template) => {
    setName(tpl ? tpl.name : "");
    setDraft(tpl ? tpl.steps.map(draftFromDef) : [{ name: "", action: tools[0]?.name || "", args: "{}", verifyText: "" }]);
    setBuilderError(null);
    setBuilderOpen(true);
  };

  const highTier = draft.filter((s) => (toolMap.get(s.action)?.tier ?? 0) >= 3);

  const submit = async () => {
    setBuilderError(null);
    if (!name.trim()) return setBuilderError("Give the workflow a name.");
    if (!draft.length) return setBuilderError("Add at least one step.");
    const steps: WfStepDef[] = [];
    for (let i = 0; i < draft.length; i++) {
      const d = draft[i];
      if (!d.action) return setBuilderError(`Step ${i + 1}: choose a tool.`);
      if (tools.length && !toolMap.has(d.action)) return setBuilderError(`Step ${i + 1}: unknown tool "${d.action}".`);
      let args: Record<string, unknown> = {};
      try {
        const parsed = d.args.trim() ? JSON.parse(d.args) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        args = parsed;
      } catch { return setBuilderError(`Step ${i + 1}: arguments must be a JSON object.`); }
      const step: WfStepDef = { name: d.name.trim() || `Step ${i + 1}`, action: d.action, args };
      if (d.verifyText.trim()) step.verify = { text: d.verifyText.trim(), timeout_seconds: 8 };
      steps.push(step);
    }
    setSubmitting(true);
    try {
      const out = await api.submitWorkflow({
        name: name.trim(), device_id: deviceId || "local", steps,
        stop_on_failure: stopOnFailure, max_retries: Math.max(0, maxRetries),
        require_step_approval: requireStepApproval,
      });
      const wf = normalize(await api.workflowDetail(out.workflow_id).catch(() => ({ ...out, id: out.workflow_id, steps, results: [] })));
      upsert(wf);
      selectWorkflow(wf.id);
      setBuilderOpen(false);
      pushNotice({ tone: "success", title: `Workflow ${wf.id} dispatched (${steps.length} steps).` });
    } catch (e: any) {
      const m = errMsg(e);
      setBuilderError(/40[13]/.test(m) ? `Not permitted / approval required: ${m}` : m);
    } finally { setSubmitting(false); }
  };

  const copy = (v: unknown) => {
    navigator.clipboard?.writeText(JSON.stringify(v, null, 2));
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const inputCls = "w-full px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] text-xs font-mono outline-none focus:border-indigo-500";

  return (
    <div className="space-y-4" data-testid="workflows-live">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-[var(--product-line)]">
        <div className="flex items-center gap-2 text-[var(--product-text)] font-semibold text-sm"><Workflow className="w-4 h-4 text-indigo-400" /> Workflows</div>
        <div className="flex flex-wrap items-center gap-3">
          <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} />
          {syncState === "error" && syncError && (
            <span role="alert" className="text-xs text-rose-300">Sync failed: {syncError}</span>
          )}
          <button type="button" onClick={() => void refresh()} className="px-3 py-2 rounded-md bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] text-xs flex items-center gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button type="button" onClick={() => openBuilder()} className="px-3.5 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-2">
            <Plus className="w-4 h-4" /> New workflow
          </button>
        </div>
      </div>

      {loadError && (
        <div role="alert" className="p-3 rounded-xl border border-rose-500/40 bg-rose-950/40 text-xs text-rose-300 flex items-center justify-between gap-3">
          <span>Could not load workflows: {loadError}</span>
          <button type="button" onClick={() => void refresh()} className="underline">Retry</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <section className="lg:col-span-4 rounded-2xl bg-[var(--product-surface)]/70 border border-[var(--product-line)] p-4 space-y-3" aria-label="Workflow directory">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[var(--product-text-dim)] absolute left-3 top-3 pointer-events-none" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, id, device, tool..." aria-label="Search workflows" className={`${inputCls} pl-8`} />
          </div>
          <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] font-mono text-[11px]">
            {FILTERS.map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={`flex-1 py-1 px-1.5 rounded-lg capitalize ${filter === f ? "bg-[var(--product-raised)] text-[var(--product-text)] font-semibold" : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"}`}>
                {f} ({counts[f] || 0})
              </button>
            ))}
          </div>
          <div tabIndex={0} aria-label="Workflow plans" className="space-y-2 max-h-[580px] overflow-y-auto pr-1">
            {loading && !workflows.length && <p className="text-xs text-[var(--product-text-dim)]">Loading workflows…</p>}
            {!loading && !loadError && !workflows.length && (
              <EmptyState variant="bare" title="No workflows yet" description="Create one or start from a template." />
            )}
            {!loading && workflows.length > 0 && !filtered.length && (
              <EmptyState variant="bare" title="No workflows match this filter" description="Try a different search or filter." />
            )}
            {filtered.map((w) => (
              <button key={w.id} type="button" id={`workflow-row-${w.id}`} onClick={() => selectWorkflow(w.id)}
                className={`w-full text-left p-3 rounded-xl border text-xs ${w.id === selectedId ? "bg-indigo-950/50 border-indigo-500/60" : "bg-[var(--product-canvas)]/70 border-[var(--product-line)] hover:border-[var(--product-line)]"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-[var(--product-text)] block truncate">{w.name}</span>
                    <span className="font-mono text-[11px] text-indigo-400">{w.id} • {w.device_id || "local"}</span>
                  </div>
                  <StatusBadge status={w.status} label={w.status === "running" ? `Step ${w.current_step}/${w.total_steps}` : undefined} />
                </div>
                <div className="mt-2 text-[11px] font-mono text-[var(--product-text-dim)]">{w.total_steps} steps • {fmtTime(w.created_at)}</div>
              </button>
            ))}
          </div>

          <div className="pt-3 border-t border-[var(--product-line)] space-y-1.5">
            <span className="text-[11px] uppercase text-[var(--product-text-dim)] font-mono">Templates</span>
            {!templates.length && (
              <EmptyState variant="bare" title="No templates available" description="Save a workflow as a template to reuse it here." />
            )}
            {templates.map((t) => (
              <div key={t.id} className="w-full text-left p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] hover:border-indigo-500/50 text-xs flex items-start justify-between gap-2">
                <button type="button" onClick={() => openBuilder(t)} className="min-w-0 flex-1 text-left">
                  <span className="text-[var(--product-text-secondary)] font-semibold block truncate">{t.name}</span>
                  <span className="text-[11px] text-[var(--product-text-dim)]">{t.description} ({t.steps.length} steps)</span>
                </button>
                {t.custom && (
                  <button type="button" aria-label={`Delete custom template ${t.name}`} onClick={(e) => removeTemplate(t.id, t.name, e)} className="p-1 text-[var(--product-text-dim)] hover:text-rose-400 shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="lg:col-span-8 space-y-5" aria-label="Workflow detail">
          {/* UX-13/UX-27: a deep-linked workflow id that matches nothing
              renders an explicit state instead of the first workflow. */}
          {workflowNotFound ? (
            <EmptyState
              variant="bare"
              title="Workflow not available"
              description={`The workflow “${routeWorkflowId}” is not in the current workflow list. The link may be stale, or the workflow may have been deleted.`}
              actionLabel="Show all workflows"
              onAction={() => {
                resolvedRouteWorkflowRef.current = null;
                setRouteWorkflowId(null);
                setWorkflowNotFound(false);
                setSelectedId(workflows[0]?.id ?? null);
                updateRouteParams({ workflow: undefined });
              }}
            />
          ) : !selected ? (
            <EmptyState
              variant="bare"
              title={loading ? "Loading…" : "Select a workflow"}
              description={loading ? undefined : "Select a workflow to inspect its steps and results."}
            />
          ) : (
            <>
              <div className="rounded-2xl bg-[var(--product-surface)]/70 border border-[var(--product-line)] p-4 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-[var(--product-text)]">{selected.name}</h2>
                    <p className="text-[11px] font-mono text-[var(--product-text-dim)]">{selected.id} • device {selected.device_id || "local"} • started {fmtTime(selected.created_at)}{selected.completed_at ? ` • finished ${fmtTime(selected.completed_at)}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={selected.status} />
                    {selectedActive && (
                      <button type="button" disabled={cancelling} onClick={() => void cancel()} className="px-3 py-1.5 rounded-md bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20 text-rose-300 font-mono text-xs flex items-center gap-1.5 disabled:opacity-50">
                        <StopCircle className="w-3.5 h-3.5" /> {cancelling ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                    {!selectedActive && selected.status === "failed" && (
                      <button type="button" onClick={() => void retry(true)} className="px-3 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 text-amber-300 font-mono text-xs flex items-center gap-1.5">
                        <RotateCcw className="w-3.5 h-3.5" /> Resume Failed Step
                      </button>
                    )}
                    {!selectedActive && (
                      <>
                        <button type="button" onClick={() => void retry(false)} className="px-3 py-1.5 rounded-md bg-indigo-500/10 border border-indigo-500/30 hover:bg-indigo-500/20 text-indigo-300 font-mono text-xs flex items-center gap-1.5">
                          <RotateCcw className="w-3.5 h-3.5" /> Re-run
                        </button>
                        <button type="button" onClick={() => void saveAsTemplate()} className="px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-300 font-mono text-xs flex items-center gap-1.5">
                          <BookmarkPlus className="w-3.5 h-3.5" /> Save Template
                        </button>
                        <button type="button" onClick={() => void scheduleRun()} className="px-3 py-1.5 rounded-md bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 text-cyan-300 font-mono text-xs flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" /> Schedule
                        </button>
                        <button type="button" onClick={() => void remove()} className="px-3 py-1.5 rounded-md bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20 text-rose-300 font-mono text-xs flex items-center gap-1.5">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {selectedActive && (
                  <div className="font-mono text-[11px] text-[var(--product-text-tertiary)]" role="status">
                    Step {selected.current_step} of {selected.total_steps} • progress via {streamMode === "stream" ? "live stream" : streamMode === "polling" ? "polling (stream unavailable)" : "connecting…"}
                  </div>
                )}
                {selected.error && <div role="alert" className="p-2 rounded-lg bg-rose-950/40 border border-rose-500/30 text-xs text-rose-300 font-mono">{selected.error}</div>}
                {!stepRows.length && (
                  <EmptyState variant="bare" title="No recorded steps" description="This workflow has no recorded steps." />
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                  {stepRows.map((s) => (
                    <button key={s.number} type="button" onClick={() => setSelectedStep(s.number)}
                      className={`text-left p-3 rounded-xl border text-xs min-h-[96px] ${activeStep?.number === s.number ? "bg-indigo-950/60 border-indigo-500 ring-1 ring-indigo-500/50" : "bg-[var(--product-canvas)]/80 border-[var(--product-line)] hover:border-[var(--product-line)]"}`}>
                      <div className="flex items-center justify-between">
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center font-mono text-xs font-bold ${s.status === "completed" ? "bg-emerald-600 text-white" : s.status === "running" ? "bg-indigo-600 text-white" : s.status === "failed" ? "bg-rose-600 text-white" : "bg-[var(--product-raised)] text-[var(--product-text-tertiary)]"}`}>{s.status === "completed" ? <Check className="w-3.5 h-3.5" /> : s.number}</span>
                        <span className="font-mono text-[11px] text-[var(--product-text-tertiary)]">{s.res?.duration_seconds != null ? `${s.res.duration_seconds}s` : "--"}</span>
                      </div>
                      <span className="font-semibold text-[var(--product-text-secondary)] block truncate mt-2">{s.name}</span>
                      <span className="font-mono text-[11px] text-[var(--product-text-tertiary)] block truncate">{s.action}</span>
                      <span className="font-mono text-[11px] text-[var(--product-text-dim)]">{s.status}</span>
                    </button>
                  ))}
                </div>
              </div>

              {activeStep && (
                <div className="rounded-2xl bg-[var(--product-surface)]/70 border border-[var(--product-line)] p-4 space-y-3 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--product-text-secondary)] font-bold">Step {activeStep.number}: {activeStep.name} <span className="text-[var(--product-text-dim)]">({activeStep.action})</span></span>
                    <button type="button" onClick={() => copy({ action: activeStep.action, args: activeStep.args, result: activeStep.res?.result })} className="px-2.5 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] text-[11px] flex items-center gap-1.5">
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-[var(--product-text-tertiary)]" />} {copied ? "Copied" : "Copy step JSON"}
                    </button>
                  </div>
                  <div>
                    <span className="text-[var(--product-text-tertiary)] block mb-1">Arguments</span>
                    <pre className="p-2.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[11px] text-[var(--product-text-secondary)] overflow-x-auto max-h-32"><code>{JSON.stringify(activeStep.args, null, 2)}</code></pre>
                  </div>
                  {activeStep.res?.error && <div role="alert" className="p-2 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300">{activeStep.res.error}</div>}
                  <div>
                    <span className="text-[var(--product-text-tertiary)] block mb-1">Result</span>
                    {activeStep.res?.result !== undefined && activeStep.res?.result !== null ? (
                      <pre className="p-2.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[11px] text-[var(--product-text-secondary)] overflow-auto max-h-64"><code>{JSON.stringify(activeStep.res.result, null, 2)}</code></pre>
                    ) : <p className="text-[var(--product-text-dim)]">{activeStep.status === "running" ? "Running…" : activeStep.status === "pending" ? "Not run yet." : "No result recorded."}</p>}
                  </div>
                  {activeStep.res?.verification !== undefined && (
                    <div>
                      <span className="text-[var(--product-text-tertiary)] block mb-1">Verification</span>
                      <pre className="p-2.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[11px] text-[var(--product-text-secondary)] overflow-auto max-h-32"><code>{JSON.stringify(activeStep.res.verification, null, 2)}</code></pre>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {workflowSchedules.length > 0 && (
        <section className="rounded-2xl bg-[var(--product-surface)]/60 border border-[var(--product-line)] p-4 space-y-3" aria-label="Scheduled workflows">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-mono uppercase tracking-wider text-[var(--product-text-tertiary)]">
              Scheduled Workflows ({workflowSchedules.length})
            </h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {workflowSchedules.map((sc) => {
              let parsedArgs: any = {};
              try { parsedArgs = JSON.parse(sc.args_json || "{}"); } catch { parsedArgs = {}; }
              const stepCount = Array.isArray(parsedArgs.steps) ? parsedArgs.steps.length : 0;
              const nextInSec = sc.next_run_at ? Math.max(0, Math.round(sc.next_run_at - Date.now() / 1000)) : null;
              return (
                <div key={sc.id} className="rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] p-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[var(--product-text)] truncate">{sc.name}</span>
                    <span className={`px-1.5 py-0.5 rounded font-mono text-[11px] ${sc.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-neutral-500/20 text-neutral-400"}`}>
                      {sc.enabled ? "active" : "paused"}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--product-text-tertiary)] flex flex-wrap gap-x-3 gap-y-1">
                    <span>{stepCount} step{stepCount === 1 ? "" : "s"}</span>
                    <span>every {sc.interval_seconds}s</span>
                    <span>device: {sc.device_id || "local"}</span>
                    {nextInSec !== null && sc.enabled && <span>next in {nextInSec}s</span>}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const res = await api.runScheduleNow(sc.id);
                          pushNotice({ tone: "success", title: `Triggered scheduled workflow (${res.workflow_id || sc.id}).` });
                          await refresh();
                        } catch (e: any) {
                          pushNotice({ tone: "error", title: "Run now failed", message: errMsg(e) });
                        }
                      }}
                      className="px-2.5 py-1 rounded-lg bg-indigo-600/80 hover:bg-indigo-500 text-white font-mono text-[11px]"
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.toggleSchedule(sc.id);
                          await refresh();
                        } catch (e: any) {
                          pushNotice({ tone: "error", title: "Toggle schedule failed", message: errMsg(e) });
                        }
                      }}
                      className="px-2.5 py-1 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)] text-[var(--product-text-secondary)] font-mono text-[11px]"
                    >
                      {sc.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm({
                        title: "Delete schedule",
                        objectName: sc.name,
                        consequence: "This deletes the schedule, so the workflow will no longer run on this interval. Past runs and the workflow itself are kept.",
                        confirmLabel: "Delete schedule",
                        run: async () => {
                          try {
                            await api.deleteSchedule(sc.id);
                            pushNotice({ tone: "success", title: `Schedule "${sc.name}" deleted.` });
                            await refresh();
                          } catch (e: any) {
                            pushNotice({ tone: "error", title: "Delete schedule failed", message: errMsg(e) });
                          }
                        },
                      })}
                      className="px-2 py-1 rounded-lg text-rose-400 hover:bg-rose-500/10 font-mono text-[11px] ml-auto"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {builderOpen && (
        <GlassModal onClose={() => setBuilderOpen(false)} title="New workflow">
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4 text-xs font-mono text-[var(--product-text-secondary)]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="workflow-name" className="text-[var(--product-text-tertiary)] uppercase text-[11px] block">
                  Name <span aria-hidden="true" className="text-rose-400">*</span><span className="sr-only"> (required)</span>
                </label>
                <input id="workflow-name" required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
              </div>
              <div className="space-y-1">
                <label htmlFor="workflow-device" className="text-[var(--product-text-tertiary)] uppercase text-[11px] block">Target device</label>
                <select id="workflow-device" aria-label="Workflow target device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={inputCls}>
                  <option value="local">local (control plane host)</option>
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.name || d.hostname || d.id}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="workflow-retries" className="text-[var(--product-text-tertiary)] uppercase text-[11px] block">Default retries per step</label>
                <input id="workflow-retries" type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} className={inputCls} />
              </div>
              <label className="sm:col-span-2 flex items-center gap-2"><input type="checkbox" checked={stopOnFailure} onChange={(e) => setStopOnFailure(e.target.checked)} /> Stop on first failed step</label>
            </div>

            <div className="space-y-2 pt-2 border-t border-[var(--product-line)]">
              <div className="flex items-center justify-between">
                <span className="text-[var(--product-text-tertiary)] uppercase text-[11px]">Steps ({draft.length})</span>
                <button type="button" onClick={() => setDraft((p) => [...p, { name: "", action: tools[0]?.name || "", args: "{}", verifyText: "" }])} className="text-indigo-400 font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add step</button>
              </div>
              {!tools.length && <p className="text-amber-400">Tool catalog unavailable; step tools can only come from templates.</p>}
              {draft.map((d, i) => {
                const t = toolMap.get(d.action);
                const upd = (patch: Partial<DraftStep>) => setDraft((p) => p.map((s, j) => (j === i ? { ...s, ...patch } : s)));
                return (
                  <div key={i} className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-indigo-400">{i + 1}.</span>
                      <label htmlFor={`wf-step-${i}-name`} className="sr-only">Step {i + 1} name</label>
                      <input id={`wf-step-${i}-name`} aria-label={`Step ${i + 1} name`} placeholder={`Step ${i + 1}`} value={d.name} onChange={(e) => upd({ name: e.target.value })} className={inputCls} />
                      <label htmlFor={`wf-step-${i}-tool`} className="sr-only">Step {i + 1} tool</label>
                      <select id={`wf-step-${i}-tool`} aria-label={`Step ${i + 1} tool`} value={d.action} onChange={(e) => upd({ action: e.target.value })} className={inputCls}>
                        {d.action && !t && <option value={d.action}>{d.action}</option>}
                        {tools.map((tl) => <option key={tl.name} value={tl.name}>{tl.name} (tier {tl.tier ?? "?"})</option>)}
                      </select>
                      <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => setDraft((p) => p.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4 text-[var(--product-text-dim)] hover:text-rose-400" /></button>
                    </div>
                    {t?.description && <p className="text-[11px] text-[var(--product-text-dim)]">{t.description}</p>}
                    <label htmlFor={`wf-step-${i}-args`} className="sr-only">Step {i + 1} arguments (JSON)</label>
                    <textarea id={`wf-step-${i}-args`} aria-label={`Step ${i + 1} arguments`} rows={2} value={d.args} onChange={(e) => upd({ args: e.target.value })} className={inputCls} />
                    {t?.parameters?.properties && <p className="text-[11px] text-[var(--product-text-dim)]">Params: {Object.keys(t.parameters.properties).join(", ") || "none"}{t.parameters.required?.length ? ` (required: ${t.parameters.required.join(", ")})` : ""}</p>}
                    <label htmlFor={`wf-step-${i}-verify`} className="sr-only">Step {i + 1} verify text</label>
                    <input id={`wf-step-${i}-verify`} aria-label={`Step ${i + 1} verify text`} placeholder="Optional: verify this text appears on screen after the step" value={d.verifyText} onChange={(e) => upd({ verifyText: e.target.value })} className={inputCls} />
                  </div>
                );
              })}
            </div>

            {highTier.length > 0 && (
              <div role="alert" className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-600/40 text-amber-300 space-y-2">
                <div className="flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{highTier.length} step(s) use tier 3+ (sensitive) tools.</span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-[11px]">
                  <input type="checkbox" checked={requireStepApproval} onChange={(e) => setRequireStepApproval(e.target.checked)} className="accent-amber-500" />
                  <span>Pause and require human approval before each tier 3+ step</span>
                </label>
              </div>
            )}
            {builderError && <div role="alert" className="p-2 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300">{builderError}</div>}
            <div className="pt-3 border-t border-[var(--product-line)] flex justify-end gap-2">
              <button type="button" onClick={() => setBuilderOpen(false)} className="px-3 py-1.5 rounded-md bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-tertiary)]">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-semibold disabled:opacity-50">{submitting ? "Dispatching…" : "Dispatch workflow"}</button>
            </div>
          </form>
        </GlassModal>
      )}

      {scheduleOpen && (
        <GlassModal onClose={() => setScheduleOpen(false)} title="Schedule workflow">
          <form onSubmit={(e) => { e.preventDefault(); void confirmScheduleRun(); }} className="space-y-4 text-xs font-mono text-[var(--product-text-secondary)]">
            <p className="text-[var(--product-text-tertiary)]">
              Run “{selected?.name}” on a repeating schedule. The workflow itself is unchanged.
            </p>
            <div className="space-y-1">
              <label htmlFor="schedule-interval" className="text-[var(--product-text-tertiary)] uppercase text-[11px] block">Interval in seconds (minimum 60)</label>
              <input id="schedule-interval" type="number" min={60} value={scheduleInterval} onChange={(e) => setScheduleInterval(Number(e.target.value))} className={inputCls} />
            </div>
            <div className="pt-3 border-t border-[var(--product-line)] flex justify-end gap-2">
              <button type="button" onClick={() => setScheduleOpen(false)} className="px-3 py-1.5 rounded-md bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-tertiary)]">Cancel</button>
              <button type="submit" className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-semibold">Save schedule</button>
            </div>
          </form>
        </GlassModal>
      )}

      {deleteConfirm && (
        <ConfirmDestructive
          open
          title={deleteConfirm.title}
          objectName={deleteConfirm.objectName}
          consequence={deleteConfirm.consequence}
          confirmLabel={deleteConfirm.confirmLabel}
          onConfirm={() => { const run = deleteConfirm.run; setDeleteConfirm(null); void run(); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

export const WorkflowsView: React.FC = () => {
  const live = !!(token() || sessionToken());
  return live ? <WorkflowsLive /> : <WorkflowsDemoView />;
};

export default WorkflowsView;
