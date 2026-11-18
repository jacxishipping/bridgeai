/**
 * Security Policies (Screen 11).
 * Live mode (admin token or session present): real device policy + global policy versions from the control plane.
 * Demo mode (not signed in): seeded, clearly demo-only fixtures from ./SecurityPoliciesDemo.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { api, token, sessionToken } from "../api";
import type { PolicySimulateResult } from "../api";
import { SecurityPoliciesDemo } from "./SecurityPoliciesDemo";
import { ConfirmDestructive, EmptyState, JXButton, JXTabs } from "../ui";
import { Freshness } from "../components/Freshness";
import { useDashboardStore } from "../state/dashboardStore";
import { useScrollShadow } from "../hooks/useScrollShadow";
import { AccountsPanel } from "./live/AccountsPanel";

type Tri = "inherit" | "allow" | "deny";
interface ToolRow { tool: string; tier: number; tier_name: string; allowed: boolean }
interface DevicePolicyResponse {
  device_id: string;
  device_name: string;
  hostname: string;
  os: string;
  has_custom_policy: boolean;
  custom_policy: Record<string, any>;
  effective_policy: Record<string, any>;
  global_policy: Record<string, any>;
  tools: ToolRow[];
}
interface GlobalPolicy { allow_tier3: boolean; desktop_enabled: boolean; allowed_apps: string[]; allowed_services: string[]; note?: string }
interface HistoryRow { version: number; policy_json: string; created_by: string; created_at: string; note: string }
interface SimRow { tool: string; tier: number; allowed_unattended: boolean; requires_approval: boolean }

const TRI_FIELDS: { key: string; label: string }[] = [
  { key: "allow_writes", label: "File writes" },
  { key: "allow_tier3", label: "Tier 3 tools" },
  { key: "desktop_enabled", label: "Desktop control" },
  { key: "allow_shell", label: "Shell commands" },
  { key: "allow_package_install", label: "Package installs" },
  { key: "allow_file_deletion", label: "File deletion" },
];

const inputCls = "w-full p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] text-xs font-mono focus:outline-none";
const cardCls = "rounded-xl border border-[var(--product-line)] bg-[var(--product-surface)]/60 p-4 space-y-3";

/** One pending destructive confirmation (UX-03/UX-04/UX-22): the view holds
 * the action in state and only runs it from ConfirmDestructive — never
 * window.confirm. */
interface PendingConfirm {
  title: string;
  objectName?: string;
  consequence: string;
  confirmLabel: string;
  requireHold?: boolean;
  tone?: "error" | "warning";
  run: () => void | Promise<void>;
}

type PolicyTabId = "policies" | "devices" | "webhooks" | "backups" | "tenants" | "users";
const POLICY_TABS: { id: PolicyTabId; label: string }[] = [
  { id: "policies", label: "Policies" },
  { id: "devices", label: "Devices" },
  { id: "webhooks", label: "Webhooks & alerts" },
  { id: "backups", label: "Backups" },
  { id: "tenants", label: "Tenants" },
  { id: "users", label: "Users" },
];

const readPolicyTab = (): PolicyTabId => {
  if (typeof window === "undefined") return "policies";
  const query = window.location.hash.split("?")[1] || "";
  const t = new URLSearchParams(query).get("tab");
  return POLICY_TABS.some((x) => x.id === t) ? (t as PolicyTabId) : "policies";
};

/** Secret text field with a show/hide toggle (UX-21). */
function SecretField({ id, label, value, onChange, disabled, placeholder, required, errorId, error, onBlur }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  errorId?: string;
  error?: string;
  onBlur?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[11px] text-[var(--product-text-tertiary)]">
        {label}
        {required && <span aria-hidden="true" className="text-rose-400"> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? "text" : "password"}
          autoComplete="off"
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`${inputCls} pr-10`}
        />
        <button
          type="button"
          aria-pressed={show}
          aria-label={`${show ? "Hide" : "Show"} ${label}`}
          onClick={() => setShow((s) => !s)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && <p id={errorId} role="alert" className="text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}

const toTri = (v: unknown): Tri => (v === true ? "allow" : v === false ? "deny" : "inherit");
const fromTri = (v: Tri): boolean | null => (v === "allow" ? true : v === "deny" ? false : null);
const toLines = (v: unknown): string => (Array.isArray(v) ? v.join("\n") : "");
const parseLines = (s: string): string[] => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const parsePolicy = (raw: string): Partial<GlobalPolicy> => { try { return JSON.parse(raw) || {}; } catch { return {}; } };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed.");
const isForbidden = (e: unknown) => (e as { status?: number })?.status === 403 || /^403:/.test(errMsg(e));

function validateList(label: string, items: string[]): string | null {
  if (items.some((i) => i.length > 200)) return `${label}: entries must be 200 characters or fewer.`;
  if (new Set(items).size !== items.length) return `${label}: duplicate entries.`;
  return null;
}

const LiveSecurityPolicies: React.FC = () => {
  const [devices, setDevices] = useState<any[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [detail, setDetail] = useState<DevicePolicyResponse | null>(null);
  const [globalPol, setGlobalPol] = useState<{ version: number; policy: GlobalPolicy; note?: string } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [role, setRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toolsScrollRef = useRef<HTMLDivElement>(null);
  const toolsScrollShadow = useScrollShadow(toolsScrollRef);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const historyScrollShadow = useScrollShadow(historyScrollRef);
  const globalScrollRef = useRef<HTMLDivElement>(null);
  const globalScrollShadow = useScrollShadow(globalScrollRef);

  // Device form
  const [inherit, setInherit] = useState(true);
  const [unrestricted, setUnrestricted] = useState(false);
  const [tri, setTri] = useState<Record<string, Tri>>({});
  const [maxTier, setMaxTier] = useState("");
  const [apps, setApps] = useState("");
  const [services, setServices] = useState("");
  const [denied, setDenied] = useState<Set<string>>(new Set());
  const [devNote, setDevNote] = useState("");
  const [probeTool, setProbeTool] = useState("");

  // Global form
  const [gTier3, setGTier3] = useState(false);
  const [gDesktop, setGDesktop] = useState(false);
  const [gApps, setGApps] = useState("");
  const [gServices, setGServices] = useState("");
  const [gNote, setGNote] = useState("");
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [sim, setSim] = useState<SimRow[] | null>(null);

  // Webhook
  const [hookUrl, setHookUrl] = useState("");
  const [slackWebhook, setSlackWebhook] = useState("");
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [genericAlertWebhook, setGenericAlertWebhook] = useState("");
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [backups, setBackups] = useState<any[]>([]);
  const [backupBackend, setBackupBackend] = useState("");
  const [tenants, setTenants] = useState<string[]>(["default"]);
  const [hookConfigured, setHookConfigured] = useState<boolean | null>(null);
  const [hookError, setHookError] = useState("");
  // UX-31: role is "unknown" until api.me() positively establishes it;
  // editing stays off while unknown (fail closed).
  const [roleStatus, setRoleStatus] = useState<"loading" | "known" | "unknown">("loading");
  const [unrestrictedAck, setUnrestrictedAck] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ maxTier?: string; apps?: string; services?: string; gApps?: string; gServices?: string; hookUrl?: string }>({});
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [rollbackVersion, setRollbackVersion] = useState<number | null>(null);
  const [tab, setTabState] = useState<PolicyTabId>(() => readPolicyTab());
  const [probeApproval, setProbeApproval] = useState(false);
  const [probeResult, setProbeResult] = useState<PolicySimulateResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeError, setProbeError] = useState("");
  // UX-06: live sync state surfaced via Freshness in the header.
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  // UX-31: in-app navigation guard. The store holds an intercepted
  // navigation in pendingNavigation; this view renders the Stay/Leave
  // confirm for it. Sidebar, palette, keyboard shortcuts, and the
  // settings links all go through store.setCurrentView, so all of them
  // are covered; browser back/refresh is deliberately not intercepted
  // (refresh is covered by the beforeunload handler below).
  const pendingNavigation = useDashboardStore((s) => s.pendingNavigation);
  const registerNavigationGuard = useDashboardStore((s) => s.registerNavigationGuard);
  const unregisterNavigationGuard = useDashboardStore((s) => s.unregisterNavigationGuard);
  const confirmPendingNavigation = useDashboardStore((s) => s.confirmPendingNavigation);
  const cancelPendingNavigation = useDashboardStore((s) => s.cancelPendingNavigation);
  // Saved-form snapshots for the unsaved-changes indicator (UX-31).
  const deviceSnapshot = useRef("");
  const globalSnapshot = useRef("");

  const setTab = (id: PolicyTabId) => {
    setTabState(id);
    if (typeof window !== "undefined") {
      const base = "#/security-policies";
      window.history.replaceState(null, "", id === "policies" ? base : `${base}?tab=${id}`);
    }
  };

  const canEdit = roleStatus === "known" && (role === "" || role === "admin");
  const flash = (kind: "ok" | "err", text: string) => setNotice({ kind, text });

  const applyDetail = useCallback((d: DevicePolicyResponse) => {
    const c = d.custom_policy || {};
    const nextInherit = c.inherit_global !== false;
    const nextUnrestricted = Boolean(c.unrestricted);
    const nextTri = Object.fromEntries(TRI_FIELDS.map((f) => [f.key, toTri(c[f.key])]));
    const nextMaxTier = typeof c.max_tier_unattended === "number" ? String(c.max_tier_unattended) : "";
    const nextApps = toLines(c.allowed_apps);
    const nextServices = toLines(c.allowed_services);
    const nextDenied = new Set<string>(Array.isArray(c.denied_tools) ? c.denied_tools : []);
    const nextNote = typeof c.note === "string" ? c.note : "";
    setDetail(d);
    setInherit(nextInherit);
    setUnrestricted(nextUnrestricted);
    setTri(nextTri);
    setMaxTier(nextMaxTier);
    setApps(nextApps);
    setServices(nextServices);
    setDenied(nextDenied);
    setDevNote(nextNote);
    setProbeTool((p) => p || d.tools?.[0]?.tool || "");
    setUnrestrictedAck("");
    setProbeResult(null);
    setProbeError("");
    deviceSnapshot.current = JSON.stringify({
      inherit: nextInherit, unrestricted: nextUnrestricted, tri: nextTri, maxTier: nextMaxTier,
      apps: nextApps, services: nextServices, denied: [...nextDenied].sort(), devNote: nextNote,
    });
  }, []);

  const loadGlobal = useCallback(async () => {
    const [cur, hist] = await Promise.all([api.policies(), api.policyHistory()]);
    setGlobalPol(cur);
    setHistory(Array.isArray(hist) ? hist : []);
    const p = cur?.policy || {};
    setGTier3(Boolean(p.allow_tier3));
    setGDesktop(Boolean(p.desktop_enabled));
    setGApps(toLines(p.allowed_apps));
    setGServices(toLines(p.allowed_services));
    setGNote("");
    setEditVersion(null);
    setRollbackVersion(null);
    setSim(null);
    globalSnapshot.current = JSON.stringify({
      gTier3: Boolean(p.allow_tier3), gDesktop: Boolean(p.desktop_enabled),
      gApps: toLines(p.allowed_apps), gServices: toLines(p.allowed_services), gNote: "",
    });
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setForbidden(false);
    try {
      const [devs, me] = await Promise.all([api.devices(), api.me().catch(() => null)]);
      setRole(typeof me?.role === "string" ? me.role : "");
      // A successful me() with no role field is admin-token auth (may edit);
      // a failed me() leaves the role unknown and editing disabled (UX-31).
      setRoleStatus(me ? "known" : "unknown");
      const list = Array.isArray(devs) ? devs : [];
      setDevices(list);
      setDeviceId((cur) => cur || list[0]?.id || "");
      await loadGlobal();
    } catch (e) {
      if (isForbidden(e)) setForbidden(true);
      else setLoadError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [loadGlobal]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!deviceId) { setDetail(null); return; }
    let live = true;
    api.devicePolicy(deviceId).then((d) => { if (live) applyDetail(d); })
      .catch((e) => { if (live) { setDetail(null); flash("err", `Could not load device policy: ${errMsg(e)}`); } });
    return () => { live = false; };
  }, [deviceId, applyDetail]);

  useEffect(() => {
    api.getWebhook().then((w) => { setHookConfigured(Boolean(w?.configured)); setHookUrl(""); setHookError(""); })
      .catch((e) => { setHookConfigured(null); setHookError(isForbidden(e) ? "Admin role required to view webhook settings." : errMsg(e)); });
    api.alertsConfig().then((cfg) => {
      if (!cfg) return;
      setSlackWebhook(cfg.slack_webhook || "");
      setDiscordWebhook(cfg.discord_webhook || "");
      setTelegramChatId(cfg.telegram_chat_id || "");
      setGenericAlertWebhook(cfg.generic_webhook || "");
    }).catch(() => {});
    api.alertDeliveries().then((rows) => { if (Array.isArray(rows)) setDeliveries(rows); }).catch(() => {});
    api.backups().then((res) => {
      if (Array.isArray(res?.items)) setBackups(res.items);
      if (res?.backend) setBackupBackend(res.backend);
    }).catch(() => {});
    api.tenants().then((res) => { if (Array.isArray(res?.tenants)) setTenants(res.tenants); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildDeviceBody = (): { body?: Record<string, unknown>; error?: string } => {
    let mt: number | null = null;
    if (maxTier.trim() !== "") {
      mt = Number(maxTier);
      if (!Number.isInteger(mt) || mt < 0 || mt > 4) {
        setFieldErrors((p) => ({ ...p, maxTier: "Max unattended tier must be a whole number from 0 to 4." }));
        return { error: "Max unattended tier must be a whole number from 0 to 4." };
      }
    }
    const a = parseLines(apps);
    const s = parseLines(services);
    const appsErr = validateList("Allowed apps", a);
    const servicesErr = validateList("Allowed services", s);
    if (appsErr || servicesErr) {
      setFieldErrors((p) => ({ ...p, apps: appsErr || undefined, services: servicesErr || undefined }));
      return { error: appsErr || servicesErr || "Invalid list." };
    }
    setFieldErrors((p) => ({ ...p, maxTier: undefined, apps: undefined, services: undefined }));
    const known = new Set((detail?.tools || []).map((t) => t.tool));
    const unknownDenied = [...denied].filter((t) => known.size > 0 && !known.has(t));
    const body: Record<string, unknown> = {
      inherit_global: inherit,
      unrestricted: unrestricted || null,
      max_tier_unattended: mt,
      allowed_apps: a.length ? a : null,
      allowed_services: s.length ? s : null,
      allowed_tools: detail?.custom_policy?.allowed_tools ?? null,
      denied_tools: denied.size ? [...denied].filter((t) => !unknownDenied.includes(t)).sort() : null,
      note: devNote.trim(),
    };
    for (const f of TRI_FIELDS) body[f.key] = fromTri(tri[f.key] || "inherit");
    return { body };
  };

  // Field-level validation on blur for the long forms (UX-20). Errors are
  // linked to their fields with aria-invalid + aria-describedby at the input.
  const validateMaxTier = () => {
    if (maxTier.trim() === "") { setFieldErrors((p) => ({ ...p, maxTier: undefined })); return; }
    const mt = Number(maxTier);
    setFieldErrors((p) => ({ ...p, maxTier: (!Number.isInteger(mt) || mt < 0 || mt > 4) ? "Enter a whole number from 0 to 4." : undefined }));
  };
  const validateDeviceLists = () => {
    setFieldErrors((p) => ({
      ...p,
      apps: validateList("Allowed apps", parseLines(apps)) || undefined,
      services: validateList("Allowed services", parseLines(services)) || undefined,
    }));
  };
  const validateGlobalLists = () => {
    setFieldErrors((p) => ({
      ...p,
      gApps: validateList("Allowed apps", parseLines(gApps)) || undefined,
      gServices: validateList("Allowed services", parseLines(gServices)) || undefined,
    }));
  };
  const validateHookUrl = () => {
    const v = hookUrl.trim();
    setFieldErrors((p) => ({ ...p, hookUrl: v && !/^https:\/\//.test(v) ? "Webhook URL must start with https://" : undefined }));
  };

  const doSaveDevice = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      applyDetail(await api.setDevicePolicy(deviceId, body));
      flash("ok", "Device policy saved.");
    } catch (e) {
      flash("err", isForbidden(e) ? "Permission denied: admin role is required to change policy." : `Save failed: ${errMsg(e)}`);
    } finally { setBusy(false); }
  };

  const saveDevice = async () => {
    const { body, error } = buildDeviceBody();
    if (error || !body) return flash("err", error || "Invalid policy.");
    if (unrestricted) {
      // UX-04: Unrestricted removes every limit — typed acknowledgement in
      // the form plus hold-to-confirm (1200 ms) before the save runs.
      if (unrestrictedAck.trim().toUpperCase() !== "UNRESTRICTED") {
        return flash("err", "Type UNRESTRICTED in the acknowledgement field to save an unrestricted policy.");
      }
      setConfirm({
        title: "Save unrestricted device policy",
        objectName: detail?.hostname || detail?.device_name || deviceId,
        consequence: "Unrestricted removes ALL policy limits for this device: every tool may run unattended with no approval gate.",
        confirmLabel: "Save unrestricted policy",
        requireHold: true,
        run: () => void doSaveDevice(body),
      });
      return;
    }
    await doSaveDevice(body);
  };

  const resetDevice = () => {
    setConfirm({
      title: "Reset device policy",
      objectName: detail?.hostname || detail?.device_name || deviceId,
      consequence: "Removes this device's custom policy. The device will inherit the global policy.",
      confirmLabel: "Reset to global default",
      tone: "warning",
      run: async () => {
        setBusy(true);
        try {
          await api.resetDevicePolicy(deviceId);
          applyDetail(await api.devicePolicy(deviceId));
          flash("ok", "Device policy reset to the global policy.");
        } catch (e) {
          flash("err", isForbidden(e) ? "Permission denied: admin role is required to reset policy." : `Reset failed: ${errMsg(e)}`);
        } finally { setBusy(false); }
      },
    });
  };

  const buildGlobal = (): { body?: GlobalPolicy; error?: string } => {
    const a = parseLines(gApps);
    const s = parseLines(gServices);
    const appsErr = validateList("Allowed apps", a);
    const servicesErr = validateList("Allowed services", s);
    if (appsErr || servicesErr) {
      setFieldErrors((p) => ({ ...p, gApps: appsErr || undefined, gServices: servicesErr || undefined }));
      return { error: appsErr || servicesErr || "Invalid policy." };
    }
    setFieldErrors((p) => ({ ...p, gApps: undefined, gServices: undefined }));
    return { body: { allow_tier3: gTier3, desktop_enabled: gDesktop, allowed_apps: a, allowed_services: s, note: gNote.trim() } };
  };

  const runGlobal = async (label: string, fn: (b: GlobalPolicy) => Promise<unknown>) => {
    const { body, error } = buildGlobal();
    if (error || !body) return flash("err", error || "Invalid policy.");
    setBusy(true);
    try {
      await fn(body);
      await loadGlobal();
      if (deviceId) applyDetail(await api.devicePolicy(deviceId));
      flash("ok", label);
    } catch (e) {
      flash("err", isForbidden(e) ? "Permission denied: admin role is required." : `Failed: ${errMsg(e)}`);
    } finally { setBusy(false); }
  };

  const simulate = async () => {
    const { body, error } = buildGlobal();
    if (error || !body) return flash("err", error || "Invalid policy.");
    setBusy(true);
    try {
      const r = await api.simulatePolicy(body);
      setSim(Array.isArray(r?.tools) ? r.tools : []);
    } catch (e) {
      flash("err", isForbidden(e) ? "Permission denied: admin role is required to simulate." : `Simulation failed: ${errMsg(e)}`);
    } finally { setBusy(false); }
  };

  const loadVersionIntoForm = (h: HistoryRow, asEdit: boolean) => {
    const p = parsePolicy(h.policy_json);
    setGTier3(Boolean(p.allow_tier3));
    setGDesktop(Boolean(p.desktop_enabled));
    setGApps(toLines(p.allowed_apps));
    setGServices(toLines(p.allowed_services));
    setGNote(asEdit ? h.note || "" : `Rollback to v${h.version}`);
    setEditVersion(asEdit ? h.version : null);
    setRollbackVersion(asEdit ? null : h.version);
    setSim(null);
  };

  const deleteVersion = (v: number) => {
    setConfirm({
      title: "Delete policy version",
      objectName: `Policy version v${v}`,
      consequence: `This permanently deletes policy version v${v}. It cannot be restored.`,
      confirmLabel: "Delete version",
      run: async () => {
        setBusy(true);
        try {
          await api.deletePolicyVersion(v);
          await loadGlobal();
          flash("ok", `Policy version v${v} deleted.`);
        } catch (e) {
          flash("err", isForbidden(e) ? "Permission denied: admin role is required." : `Delete failed: ${errMsg(e)}`);
        } finally { setBusy(false); }
      },
    });
  };

  const saveWebhook = async (clear = false) => {
    if (!clear && hookUrl.trim() && !/^https:\/\//.test(hookUrl.trim())) {
      setFieldErrors((p) => ({ ...p, hookUrl: "Webhook URL must start with https://" }));
      return flash("err", "Webhook URL must start with https://");
    }
    setBusy(true);
    try {
      const r = await api.setWebhook(clear ? "" : hookUrl.trim());
      setHookConfigured(Boolean(r?.configured));
      setHookUrl("");
      flash("ok", clear ? "Webhook removed." : "Webhook saved.");
    } catch (e) {
      flash("err", isForbidden(e) ? "Permission denied: admin role is required." : `Webhook save failed: ${errMsg(e)}`);
    } finally { setBusy(false); }
  };

  const saveChannels = async () => {
    setBusy(true);
    try {
      await api.updateAlertsConfig({ slack_webhook: slackWebhook, discord_webhook: discordWebhook, telegram_token: telegramToken, telegram_chat_id: telegramChatId, generic_webhook: genericAlertWebhook });
      flash("ok", "Alert channels saved.");
    } catch (e) { flash("err", errMsg(e)); } finally { setBusy(false); }
  };

  const testAlerts = async () => {
    setBusy(true);
    try {
      const res = await api.testAlerts();
      const rows = await api.alertDeliveries().catch(() => []);
      if (Array.isArray(rows)) setDeliveries(rows);
      flash("ok", `Test alert dispatched: ${JSON.stringify(res?.results || {})}`);
    } catch (e) { flash("err", errMsg(e)); } finally { setBusy(false); }
  };

  // UX-31: per-tool dry-run against the live policy (tool + device +
  // approval-granted toggle). Executes nothing.
  const runProbe = async () => {
    if (!probeTool) return;
    setProbeBusy(true);
    setProbeError("");
    setProbeResult(null);
    try {
      setProbeResult(await api.simulateTool(probeTool, deviceId || undefined, probeApproval));
    } catch (e) {
      setProbeError(isForbidden(e) ? "Permission denied: admin role is required to simulate." : `Probe failed: ${errMsg(e)}`);
    } finally { setProbeBusy(false); }
  };

  const testHook = async () => {
    setBusy(true);
    try { await api.testWebhook(); flash("ok", "Test notification sent."); }
    catch (e) { flash("err", `Webhook test failed: ${errMsg(e)}`); }
    finally { setBusy(false); }
  };

  const probe = useMemo(() => {
    const t = detail?.tools.find((x) => x.tool === probeTool);
    if (!t || !detail) return null;
    const eff = detail.effective_policy || {};
    const needsApproval = t.tier >= 4 || (t.tier === 3 && !eff.allow_tier3);
    return { ...t, needsApproval };
  }, [detail, probeTool]);

  // Unsaved-changes tracking (UX-31): the current form JSON vs the last
  // saved snapshot. In-app hash navigation is intercepted by the store
  // guard (registered below); full unload is covered by beforeunload.
  const deviceFormJson = JSON.stringify({ inherit, unrestricted, tri, maxTier, apps, services, denied: [...denied].sort(), devNote });
  const globalFormJson = JSON.stringify({ gTier3, gDesktop, gApps, gServices, gNote });
  const dirty = (detail ? deviceFormJson !== deviceSnapshot.current : false) ||
    (globalPol ? globalFormJson !== globalSnapshot.current : false);
  // The guard closure must always see the latest dirty value.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    registerNavigationGuard({ isDirty: () => dirtyRef.current });
    return () => unregisterNavigationGuard();
  }, [registerNavigationGuard, unregisterNavigationGuard]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (loading) return <div role="status" className="p-6 text-sm text-[var(--product-text-tertiary)]">Loading policies from the control plane...</div>;
  if (forbidden) return <div role="alert" className="p-6 rounded-xl border border-rose-700/50 bg-rose-950/30 text-sm text-rose-300">Permission denied: your role cannot view security policies.</div>;
  if (loadError) {
    return (
      <div role="alert" className="p-6 rounded-xl border border-rose-700/50 bg-rose-950/30 text-sm text-rose-300 space-y-3">
        <p>Could not load policies: {loadError}</p>
        <JXButton variant="outlined" color="primary" size="sm" onClick={() => void loadAll()}>Retry</JXButton>
      </div>
    );
  }

  const gp = globalPol?.policy;
  const eff = detail?.effective_policy;

  // --- Tab contents (UX-31): one tab per area; only the active tab renders.
  // Form state lives in component state, so switching tabs never loses edits.
  const devicePolicySection = (
      <section className={cardCls} aria-label="Device policy">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[var(--product-text)]">Device policy</h2>
          <select id="device-policy-select" aria-label="Device" className={`${inputCls} max-w-xs`} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name || d.hostname || d.id}</option>)}
          </select>
        </div>

        {devices.length === 0 && (
          <EmptyState
            variant="bare"
            title="No devices enrolled yet"
            description="Enroll a device to manage its policy."
          />
        )}

        {detail && eff && (
          <>
            <div className="text-xs font-mono text-[var(--product-text-tertiary)]">
              {detail.hostname || detail.device_name} {detail.os && `(${detail.os})`} - source:{" "}
              <span className="text-indigo-300">{detail.has_custom_policy ? "custom device policy" : "inherits global policy"}</span>
              {eff._source === "linux_unrestricted_server" && <span className="ml-2 text-amber-300">UNRESTRICTED</span>}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); void saveDevice(); }}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-xs text-[var(--product-text-secondary)]">
                  <input type="checkbox" disabled={!canEdit} checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
                  Inherit global policy as the base
                </label>
                <label className="flex items-center gap-2 text-xs text-amber-300">
                  <input type="checkbox" disabled={!canEdit} checked={unrestricted} onChange={(e) => setUnrestricted(e.target.checked)} />
                  Unrestricted (disables all limits)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {TRI_FIELDS.map((f) => (
                    <label key={f.key} htmlFor={`tri-${f.key}`} className="text-[11px] text-[var(--product-text-tertiary)] space-y-1">
                      {f.label}
                      <select id={`tri-${f.key}`} className={inputCls} disabled={!canEdit} value={tri[f.key] || "inherit"}
                        onChange={(e) => setTri((p) => ({ ...p, [f.key]: e.target.value as Tri }))}>
                        <option value="inherit">Inherit</option>
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                    </label>
                  ))}
                </div>
                <div className="space-y-1">
                  <label htmlFor="max-tier" className="block text-[11px] text-[var(--product-text-tertiary)]">
                    Max tier run unattended (0-4, blank = inherit)
                  </label>
                  <input id="max-tier" type="number" min={0} max={4} className={inputCls} disabled={!canEdit} value={maxTier}
                    onChange={(e) => setMaxTier(e.target.value)} onBlur={validateMaxTier}
                    aria-invalid={fieldErrors.maxTier ? true : undefined}
                    aria-describedby={fieldErrors.maxTier ? "max-tier-error" : undefined} />
                  {fieldErrors.maxTier && <p id="max-tier-error" role="alert" className="text-[11px] text-rose-300">{fieldErrors.maxTier}</p>}
                </div>
              </div>
              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="allowed-apps" className="block text-[11px] text-[var(--product-text-tertiary)]">
                    Allowed apps (one per line, blank = inherit)
                  </label>
                  <textarea id="allowed-apps" className={inputCls} rows={3} disabled={!canEdit} value={apps}
                    onChange={(e) => setApps(e.target.value)} onBlur={validateDeviceLists}
                    aria-invalid={fieldErrors.apps ? true : undefined}
                    aria-describedby={fieldErrors.apps ? "allowed-apps-error" : undefined} />
                  {fieldErrors.apps && <p id="allowed-apps-error" role="alert" className="text-[11px] text-rose-300">{fieldErrors.apps}</p>}
                </div>
                <div className="space-y-1">
                  <label htmlFor="allowed-services" className="block text-[11px] text-[var(--product-text-tertiary)]">
                    Allowed services (one per line, blank = inherit)
                  </label>
                  <textarea id="allowed-services" className={inputCls} rows={3} disabled={!canEdit} value={services}
                    onChange={(e) => setServices(e.target.value)} onBlur={validateDeviceLists}
                    aria-invalid={fieldErrors.services ? true : undefined}
                    aria-describedby={fieldErrors.services ? "allowed-services-error" : undefined} />
                  {fieldErrors.services && <p id="allowed-services-error" role="alert" className="text-[11px] text-rose-300">{fieldErrors.services}</p>}
                </div>
                <div className="space-y-1">
                  <label htmlFor="device-note" className="block text-[11px] text-[var(--product-text-tertiary)]">Note</label>
                  <input id="device-note" className={inputCls} disabled={!canEdit} value={devNote} onChange={(e) => setDevNote(e.target.value)} />
                </div>
              </div>
            </div>

            {unrestricted && (
              <div className="space-y-1 mt-3">
                <label htmlFor="unrestricted-ack" className="block text-[11px] text-amber-300">
                  Type UNRESTRICTED to confirm this device removes all policy limits
                  <span aria-hidden="true" className="text-rose-400"> *</span>
                  <span className="sr-only"> (required)</span>
                </label>
                <input id="unrestricted-ack" className={inputCls} autoComplete="off" disabled={!canEdit}
                  value={unrestrictedAck} onChange={(e) => setUnrestrictedAck(e.target.value)} placeholder="UNRESTRICTED" />
              </div>
            )}

            <div className="flex flex-wrap gap-2 mt-3">
              <JXButton type="submit" variant="contained" color="primary" size="sm" loading={busy} disabled={!canEdit || busy}>Save device policy</JXButton>
              <JXButton type="button" variant="outlined" color="warning" size="sm" disabled={!canEdit || busy || !detail.has_custom_policy} onClick={() => resetDevice()}>Reset to global default</JXButton>
            </div>
            </form>

            <div className="rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-3 space-y-2">
              <h3 className="text-xs font-semibold text-[var(--product-text-secondary)]">Effective policy (what the server enforces)</h3>
              <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono text-[var(--product-text-secondary)]">
                {["allow_writes", "allow_tier3", "desktop_enabled", "allow_shell", "allow_package_install", "allow_file_deletion"].map((k) => (
                  <div key={k}><dt className="text-[var(--product-text-dim)]">{k}</dt><dd>{eff[k] === undefined ? "n/a" : String(eff[k])}</dd></div>
                ))}
                <div><dt className="text-[var(--product-text-dim)]">max_tier_unattended</dt><dd>{eff.max_tier_unattended === undefined ? "n/a" : String(eff.max_tier_unattended)}</dd></div>
                <div><dt className="text-[var(--product-text-dim)]">allowed_apps</dt><dd>{(eff.allowed_apps || []).join(", ") || "none"}</dd></div>
                <div><dt className="text-[var(--product-text-dim)]">allowed_services</dt><dd>{(eff.allowed_services || []).join(", ") || "none"}</dd></div>
                <div><dt className="text-[var(--product-text-dim)]">denied_tools</dt><dd>{(eff.denied_tools || []).length}</dd></div>
              </dl>
            </div>

            <div className="rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-3 space-y-2">
              <h3 className="text-xs font-semibold text-[var(--product-text-secondary)]">Check a tool against this device</h3>
              <label htmlFor="probe-tool-select" className="block text-[11px] text-[var(--product-text-tertiary)]">Tool</label>
              <select id="probe-tool-select" aria-label="Tool to check" className={`${inputCls} max-w-xs`} value={probeTool} onChange={(e) => setProbeTool(e.target.value)}>
                {detail.tools.map((t) => <option key={t.tool} value={t.tool}>{t.tool}</option>)}
              </select>
              {probe && (
                <p className="text-xs font-mono text-[var(--product-text-secondary)]">
                  Tier {probe.tier} ({probe.tier_name}):{" "}
                  <span className={probe.allowed ? "text-emerald-300" : "text-rose-300"}>{probe.allowed ? "permitted by policy" : "denied by policy"}</span>
                  {probe.allowed && (probe.needsApproval ? " - requires human approval" : " - may run unattended")}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-3 space-y-2">
              <h3 className="text-xs font-semibold text-[var(--product-text-secondary)]">Test a tool call (dry run)</h3>
              <p className="text-[11px] text-[var(--product-text-tertiary)]">Simulates one tool call against this device&apos;s live policy. Executes nothing.</p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-[var(--product-text-secondary)]">
                  <input type="checkbox" disabled={!canEdit} checked={probeApproval} onChange={(e) => setProbeApproval(e.target.checked)} />
                  Approval granted
                </label>
                <JXButton type="button" variant="outlined" color="primary" size="sm" loading={probeBusy} disabled={!canEdit || probeBusy || !probeTool} onClick={() => void runProbe()}>Test tool call</JXButton>
              </div>
              {probeResult && (
                <p className="text-xs font-mono text-[var(--product-text-secondary)]">
                  {probeResult.tool} — Tier {probeResult.tier ?? "?"} ({probeResult.tier_name || "unknown"}):{" "}
                  <span className={probeResult.allowed ? "text-emerald-300" : "text-rose-300"}>{probeResult.allowed ? "allowed" : "denied"}</span>
                  {probeResult.allowed && (probeResult.needs_approval ? " — requires human approval" : " — may run unattended")}
                  {probeResult.reason ? ` — ${probeResult.reason}` : ""}
                </p>
              )}
              {probeError && <p role="alert" className="text-xs text-rose-300">{probeError}</p>}
            </div>

            <div ref={toolsScrollRef} tabIndex={0} role="region" aria-label="Device tools policy" className="overflow-x-auto scroll-shadow rounded-xl border border-[var(--product-line)] max-h-80 overflow-y-auto" data-scroll-left={toolsScrollShadow.left} data-scroll-right={toolsScrollShadow.right}>
              <table className="w-full min-w-[560px] text-left text-xs border-collapse">
                <caption className="sr-only">Per-tool policy for this device</caption>
                <thead>
                  <tr className="bg-[var(--product-canvas)] border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] font-mono uppercase sticky top-0">
                    <th scope="col" className="p-2">Tool</th><th scope="col" className="p-2">Tier</th><th scope="col" className="p-2">Effective</th><th scope="col" className="p-2">Deny on this device</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--product-line)] font-mono">
                  {detail.tools.map((t) => (
                    <tr key={t.tool}>
                      <td className="p-2 text-[var(--product-text-secondary)]">{t.tool}</td>
                      <td className="p-2 text-[var(--product-text-tertiary)]">{t.tier} {t.tier_name}</td>
                      <td className={`p-2 ${t.allowed ? "text-emerald-300" : "text-rose-300"}`}>{t.allowed ? "allowed" : "denied"}</td>
                      <td className="p-2">
                        <input type="checkbox" aria-label={`Deny ${t.tool}`} disabled={!canEdit} checked={denied.has(t.tool)}
                          onChange={(e) => setDenied((p) => { const n = new Set(p); if (e.target.checked) n.add(t.tool); else n.delete(t.tool); return n; })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
  );

  const globalPolicySection = (
      <section className={cardCls} aria-label="Global policy">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--product-text)]">Global policy</h2>
          <span className="text-xs font-mono text-[var(--product-text-tertiary)]">
            {globalPol && globalPol.version > 0 ? `active version v${globalPol.version}` : "no versioned policy yet - environment defaults apply"}
          </span>
        </div>
        {gp && (
          <p className="text-[11px] font-mono text-[var(--product-text-dim)]">
            Active: tier3={String(gp.allow_tier3)} desktop={String(gp.desktop_enabled)} apps={(gp.allowed_apps || []).length} services={(gp.allowed_services || []).length}
          </p>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void runGlobal("Published a new policy version.", (b) => api.createPolicy(b)); }}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-[var(--product-text-secondary)]">
              <input type="checkbox" disabled={!canEdit} checked={gTier3} onChange={(e) => setGTier3(e.target.checked)} /> Allow Tier 3 tools unattended
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--product-text-secondary)]">
              <input type="checkbox" disabled={!canEdit} checked={gDesktop} onChange={(e) => setGDesktop(e.target.checked)} /> Desktop control enabled
            </label>
            <div className="space-y-1">
              <label htmlFor="global-note" className="block text-[11px] text-[var(--product-text-tertiary)]">Note</label>
              <input id="global-note" className={inputCls} disabled={!canEdit} value={gNote} onChange={(e) => setGNote(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <label htmlFor="global-apps" className="block text-[11px] text-[var(--product-text-tertiary)]">Allowed apps (one per line)</label>
              <textarea id="global-apps" className={inputCls} rows={3} disabled={!canEdit} value={gApps}
                onChange={(e) => setGApps(e.target.value)} onBlur={validateGlobalLists}
                aria-invalid={fieldErrors.gApps ? true : undefined}
                aria-describedby={fieldErrors.gApps ? "global-apps-error" : undefined} />
              {fieldErrors.gApps && <p id="global-apps-error" role="alert" className="text-[11px] text-rose-300">{fieldErrors.gApps}</p>}
            </div>
            <div className="space-y-1">
              <label htmlFor="global-services" className="block text-[11px] text-[var(--product-text-tertiary)]">Allowed services (one per line)</label>
              <textarea id="global-services" className={inputCls} rows={3} disabled={!canEdit} value={gServices}
                onChange={(e) => setGServices(e.target.value)} onBlur={validateGlobalLists}
                aria-invalid={fieldErrors.gServices ? true : undefined}
                aria-describedby={fieldErrors.gServices ? "global-services-error" : undefined} />
              {fieldErrors.gServices && <p id="global-services-error" role="alert" className="text-[11px] text-rose-300">{fieldErrors.gServices}</p>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <JXButton type="button" variant="outlined" color="primary" size="sm" disabled={!canEdit || busy} onClick={() => void simulate()}>Simulate impact</JXButton>
          <JXButton type="submit" variant="contained" color="primary" size="sm" disabled={!canEdit || busy}>Publish as new version</JXButton>
          {editVersion !== null && (
            <JXButton type="button" variant="soft" color="warning" size="sm" disabled={!canEdit || busy}
              onClick={() => void runGlobal(`Updated policy version v${editVersion}.`, (b) => api.updatePolicyVersion(editVersion, b))}>
              Overwrite v{editVersion}
            </JXButton>
          )}
        </div>
        </form>
        {sim && (
          <div ref={globalScrollRef} tabIndex={0} role="region" aria-label="Policy simulation" className="overflow-x-auto scroll-shadow rounded-xl border border-[var(--product-line)] max-h-64 overflow-y-auto" data-scroll-left={globalScrollShadow.left} data-scroll-right={globalScrollShadow.right}>
            <table className="w-full min-w-[480px] text-left text-xs border-collapse">
              <caption className="sr-only">Simulated impact of the proposed policy</caption>
              <thead><tr className="bg-[var(--product-canvas)] border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] font-mono uppercase"><th scope="col" className="p-2">Tool</th><th scope="col" className="p-2">Tier</th><th scope="col" className="p-2">Under proposed policy</th></tr></thead>
              <tbody className="divide-y divide-[var(--product-line)] font-mono">
                {sim.map((r) => (
                  <tr key={r.tool}>
                    <td className="p-2 text-[var(--product-text-secondary)]">{r.tool}</td>
                    <td className="p-2 text-[var(--product-text-tertiary)]">{r.tier}</td>
                    <td className={`p-2 ${r.allowed_unattended ? "text-emerald-300" : "text-amber-300"}`}>{r.allowed_unattended ? "runs unattended" : "requires approval"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="text-sm font-semibold text-[var(--product-text-secondary)] pt-2">Version history</h3>
        {history.length === 0 ? (
          <EmptyState
            variant="bare"
            title="No policy versions published yet"
            description="Publish a new version to start version history."
          />
        ) : (
          <div ref={historyScrollRef} tabIndex={0} role="region" aria-label="Policy version history" className="overflow-x-auto scroll-shadow rounded-xl border border-[var(--product-line)]" data-scroll-left={historyScrollShadow.left} data-scroll-right={historyScrollShadow.right}>
            <table className="w-full min-w-[720px] text-left text-xs border-collapse">
              <caption className="sr-only">Policy version history</caption>
              <thead><tr className="bg-[var(--product-canvas)] border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] font-mono uppercase">
                <th scope="col" className="p-2">Version</th><th scope="col" className="p-2">Created</th><th scope="col" className="p-2">By</th><th scope="col" className="p-2">Settings</th><th scope="col" className="p-2">Note</th><th scope="col" className="p-2 text-right">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-[var(--product-line)] font-mono">
                {history.map((h) => {
                  const p = parsePolicy(h.policy_json);
                  return (
                    <tr key={h.version}>
                      <td className="p-2 text-[var(--product-text-secondary)]">v{h.version}{globalPol?.version === h.version && <span className="ml-2 text-emerald-300">active</span>}</td>
                      <td className="p-2 text-[var(--product-text-tertiary)]">{h.created_at}</td>
                      <td className="p-2 text-[var(--product-text-tertiary)]">{h.created_by}</td>
                      <td className="p-2 text-[var(--product-text-tertiary)]">tier3={String(!!p.allow_tier3)} desktop={String(!!p.desktop_enabled)} apps={(p.allowed_apps || []).length} svc={(p.allowed_services || []).length}</td>
                      <td className="p-2 text-[var(--product-text-tertiary)]">{h.note}</td>
                      <td className="p-2 text-right space-x-1 whitespace-nowrap">
                        <JXButton variant="soft" color="primary" size="sm" disabled={!canEdit} onClick={() => loadVersionIntoForm(h, false)}>Roll back (as new)</JXButton>
                        <JXButton variant="soft" color="primary" size="sm" disabled={!canEdit} onClick={() => loadVersionIntoForm(h, true)}>Edit</JXButton>
                        <JXButton variant="soft" color="error" size="sm" disabled={!canEdit || busy} onClick={() => deleteVersion(h.version)}>Delete</JXButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
  );

  const webhookSection = (
      <section className={cardCls} aria-label="Alert webhook">
        <h2 className="text-base font-semibold text-[var(--product-text)]">Alert webhook</h2>
        {hookError ? (
          <p className="text-xs text-amber-300">{hookError}</p>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void saveWebhook(); }} className="space-y-3">
            <p className="text-xs text-[var(--product-text-tertiary)]">
              {hookConfigured === null ? "Checking..." : hookConfigured ? "A webhook is configured (URL hidden)." : "No webhook configured."}
            </p>
            <SecretField
              id="alert-webhook-url"
              label="Webhook URL"
              required
              placeholder="https://hooks.example.com/..."
              value={hookUrl}
              onChange={setHookUrl}
              onBlur={validateHookUrl}
              disabled={!canEdit}
              errorId="alert-webhook-url-error"
              error={fieldErrors.hookUrl}
            />
            <div className="flex flex-wrap gap-2">
              <JXButton type="submit" variant="contained" color="primary" size="sm" disabled={!canEdit || busy || !hookUrl.trim()}>Save webhook</JXButton>
              <JXButton type="button" variant="outlined" color="primary" size="sm" disabled={busy || !hookConfigured} onClick={() => void testHook()}>Send test</JXButton>
              <JXButton type="button" variant="soft" color="error" size="sm" disabled={!canEdit || busy || !hookConfigured} onClick={() => void saveWebhook(true)}>Remove</JXButton>
            </div>
          </form>
        )}
      </section>
  );

  const channelsSection = (
      <section className={cardCls} aria-label="Multi-channel alerts">
        <form onSubmit={(e) => { e.preventDefault(); void saveChannels(); }} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--product-text)]">Alert channels &amp; delivery history</h2>
          <div className="flex items-center gap-2">
            <JXButton type="submit" variant="contained" color="primary" size="sm" disabled={!canEdit || busy}>Save channels</JXButton>
            <JXButton type="button" variant="outlined" color="primary" size="sm" disabled={!canEdit || busy} onClick={() => void testAlerts()}>Send test alert</JXButton>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <SecretField id="slack-webhook-url" label="Slack Webhook URL" placeholder="https://hooks.slack.com/services/..."
            value={slackWebhook} onChange={setSlackWebhook} disabled={!canEdit} />
          <SecretField id="discord-webhook-url" label="Discord Webhook URL" placeholder="https://discord.com/api/webhooks/..."
            value={discordWebhook} onChange={setDiscordWebhook} disabled={!canEdit} />
          <SecretField id="telegram-bot-token" label="Telegram Bot Token" placeholder="123456:ABC-..."
            value={telegramToken} onChange={setTelegramToken} disabled={!canEdit} />
          <div className="space-y-1">
            <label htmlFor="telegram-chat-id" className="block text-[11px] text-[var(--product-text-tertiary)]">Telegram Chat ID</label>
            <input id="telegram-chat-id" className={inputCls} autoComplete="off" disabled={!canEdit} placeholder="-1001234567890" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <SecretField id="generic-webhook-url" label="Generic Incident Webhook URL" placeholder="https://alerts.example.com/webhook"
              value={genericAlertWebhook} onChange={setGenericAlertWebhook} disabled={!canEdit} />
          </div>
        </div>
        </form>
        {deliveries.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-[var(--product-line)]">
            <table className="w-full min-w-[520px] text-left text-xs font-mono">
              <caption className="sr-only">Alert delivery history</caption>
              <thead className="bg-[var(--product-canvas)] text-[var(--product-text-tertiary)]">
                <tr><th scope="col" className="p-2">Channel</th><th scope="col" className="p-2">Event</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Detail</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--product-line)]">
                {deliveries.slice(0, 10).map((d) => (
                  <tr key={d.id}>
                    <td className="p-2 text-[var(--product-text-secondary)]">{d.channel}</td>
                    <td className="p-2 text-[var(--product-text-tertiary)]">{d.event_type}</td>
                    <td className="p-2"><span className={d.status === "delivered" ? "text-emerald-300" : "text-rose-300"}>{d.status}</span></td>
                    <td className="p-2 text-[var(--product-text-dim)]">{d.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
  );

  const backupsSection = (
      <section className={cardCls} aria-label="Database backups">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-[var(--product-text)]">Database backups &amp; snapshots</h2>
            <p className="text-xs text-[var(--product-text-tertiary)]">Backend: {backupBackend || "auto"} • Verified offline-safe snapshots.</p>
          </div>
          <JXButton variant="contained" color="primary" size="sm" disabled={!canEdit || busy} onClick={async () => {
            setBusy(true);
            try {
              const created = await api.createBackup();
              const res = await api.backups();
              if (Array.isArray(res?.items)) setBackups(res.items);
              flash("ok", `Backup created: ${created.filename}`);
            } catch (e) { flash("err", errMsg(e)); } finally { setBusy(false); }
          }}>Create backup</JXButton>
        </div>
        {backups.length === 0 ? (
          <EmptyState
            variant="bare"
            title="No backups created yet"
            description="Create a backup to capture a snapshot of the control-plane database."
          />
        ) : (
          <ul className="divide-y divide-[var(--product-line)] text-xs font-mono">
            {backups.slice(0, 10).map((b) => (
              <li key={b.filename} className="py-2 flex items-center justify-between gap-3">
                <span className="text-[var(--product-text-secondary)]">{b.filename}</span>
                <div className="flex items-center gap-3">
                  <span className="text-[var(--product-text-tertiary)]">{Math.round((b.size_bytes || 0) / 1024)} KB</span>
                  <button
                    type="button"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const blob = await api.downloadBackupBlob(b.filename);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = b.filename;
                        a.click();
                        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                      } catch (e) {
                        flash("err", errMsg(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    className="text-indigo-400 hover:underline"
                  >
                    Download
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm({
                        title: "Restore database backup",
                        objectName: b.filename,
                        consequence: `Restores the control-plane database from ${b.filename}, replacing current data. A pre-restore safety snapshot is created automatically.`,
                        confirmLabel: "Restore backup",
                        tone: "warning",
                        run: async () => {
                          setBusy(true);
                          try {
                            const res = await api.restoreBackup(b.filename);
                            const listRes = await api.backups();
                            if (Array.isArray(listRes?.items)) setBackups(listRes.items);
                            flash("ok", `Restored from ${b.filename} (safety backup: ${res.safety_backup})`);
                          } catch (e) { flash("err", errMsg(e)); } finally { setBusy(false); }
                        },
                      })}
                      className="text-amber-400 hover:underline disabled:opacity-50"
                    >
                      Restore
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
  );

  const tenantsSection = (
      <section className={cardCls} aria-label="Tenants">
        <h2 className="text-base font-semibold text-[var(--product-text)]">Tenants</h2>
        <p className="text-xs text-[var(--product-text-tertiary)]">Policy and data are scoped per tenant. The control plane reports the tenants below.</p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
          {tenants.map((tn) => (
            <span key={tn} className="px-2 py-0.5 rounded bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)]">{tn}</span>
          ))}
        </div>
      </section>
  );

  const usersSection = (
      <section className={cardCls} aria-label="Users and roles">
        <h2 className="text-base font-semibold text-[var(--product-text)]">Users &amp; roles</h2>
        <AccountsPanel admin={canEdit} />
      </section>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} />
        {dirty && <span className="text-xs font-mono text-amber-300">Unsaved changes</span>}
        {syncState === "error" && syncError && (
          <span role="alert" className="text-xs text-rose-300">Sync failed: {syncError}</span>
        )}
      </div>
      {notice && (
        <div role={notice.kind === "err" ? "alert" : "status"}
          className={`rounded-lg border p-3 text-xs font-mono ${notice.kind === "ok" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-rose-500/10 border-rose-500/30 text-rose-300"}`}>
          {notice.text}
        </div>
      )}
      {roleStatus === "unknown" && (
        <div role="alert" className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-300">
          Role unknown — read-only until verified. The control plane did not confirm your role, so policy editing is disabled.
        </div>
      )}
      {roleStatus === "known" && !canEdit && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-300">
          Your role ({role}) is read-only. Changing policy requires the admin role.
        </div>
      )}
      {editVersion !== null && (
        <div role="status" className="rounded-lg border border-indigo-500/40 bg-indigo-950/40 p-3 text-xs text-indigo-200">
          Editing policy v{editVersion} — Publish creates a new version; Overwrite replaces v{editVersion}.
        </div>
      )}
      {editVersion === null && rollbackVersion !== null && (
        <div role="status" className="rounded-lg border border-indigo-500/40 bg-indigo-950/40 p-3 text-xs text-indigo-200">
          Rollback draft from v{rollbackVersion} — Publish creates a new version from it; Overwrite is not available for a rollback draft.
        </div>
      )}
      <JXTabs
        value={tab}
        onChange={(id) => setTab(id as PolicyTabId)}
        tabs={[
          { id: "policies", label: "Policies", content: globalPolicySection },
          { id: "devices", label: "Devices", content: devicePolicySection },
          { id: "webhooks", label: "Webhooks & alerts", content: (<div className="space-y-4">{webhookSection}{channelsSection}</div>) },
          { id: "backups", label: "Backups", content: backupsSection },
          { id: "tenants", label: "Tenants", content: tenantsSection },
          { id: "users", label: "Users", content: usersSection },
        ]}
      />
      {confirm && (
        <ConfirmDestructive
          open
          title={confirm.title}
          objectName={confirm.objectName}
          consequence={confirm.consequence}
          confirmLabel={confirm.confirmLabel}
          requireHold={confirm.requireHold}
          tone={confirm.tone}
          onConfirm={() => { const run = confirm.run; setConfirm(null); void run(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {/* UX-31: in-app navigation intercepted with unsaved edits — Stay
          keeps the form, Leave without saving completes the navigation. */}
      {pendingNavigation && (
        <ConfirmDestructive
          open
          title="Leave without saving?"
          objectName="Unsaved policy edits"
          consequence="You have unsaved policy changes. Leaving now discards them."
          confirmLabel="Leave without saving"
          tone="warning"
          onConfirm={() => confirmPendingNavigation()}
          onCancel={() => cancelPendingNavigation()}
        />
      )}
    </div>
  );
};

export const SecurityPoliciesView: React.FC = () => {
  const live = typeof window !== "undefined" && Boolean(token() || sessionToken());
  return live ? <LiveSecurityPolicies /> : <SecurityPoliciesDemo />;
};

export default SecurityPoliciesView;
