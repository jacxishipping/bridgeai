import React, { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound, UserRound } from "lucide-react";
import { FrostedGlass, JXAlert, JXButton, JXCardContent, JXTextField } from "../ui";
import { Brand, BrandArt } from "../Brand";
import { api, apiOrigin, authenticate, probeControlHealth } from "../api";
import { dashboardStore, useDashboardStore } from "../state/dashboardStore";
import { LanguageControl } from "../LanguageControl";
import { ThemeControl } from "../ThemeControl";
import { useLanguage } from "../i18n";

/**
 * Map a sign-in failure to actionable copy (UX-26 / UX-18). A 401 means
 * the credential itself was rejected; a network failure means the control
 * plane could not be reached at all — the next step differs, so the copy
 * must say which one happened instead of echoing the raw server string.
 */
function describeSignInError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "Sign-in failed. Please try again.";
  if (/401|unauthorized|session expired/i.test(raw)) {
    return "Your token or account was rejected (401). Ask an admin to check the token or re-enable your account, then try again.";
  }
  if (/cannot reach|timed out|timeout|network|failed to fetch|econnrefused/i.test(raw)) {
    return `${raw} Check that the control plane is running and reachable from this browser, then try again.`;
  }
  return raw;
}

export const LoginView: React.FC = () => {
  const { t } = useLanguage();
  const navigate = useDashboardStore((s) => s.setCurrentView);
  const [method, setMethod] = useState<"token" | "password">("token");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Show/hide toggles for the secret fields (UX-21): a mistyped token or
  // password is invisible otherwise, and there is no other way to verify it.
  const [showToken, setShowToken] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ssoConfigured, setSsoConfigured] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; detail: string; version?: string } | null>(null);
  const [probing, setProbing] = useState(true);
  // UX-26: a failed health probe is a warning, not a block. The probe is
  // best-effort (cold-start hosts are slow); the sign-in attempt itself is
  // the real test, and its error is what the user needs to see.
  const [probeWarning, setProbeWarning] = useState("");
  useEffect(() => {
    let active = true;
    api.oidcConfigured().then((data) => { if (active) setSsoConfigured(Boolean(data.enabled)); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setProbing(true);
    probeControlHealth().then((result) => {
      if (active) { setHealth(result); setProbing(false); }
    });
    return () => { active = false; };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setProbeWarning("");
    try {
      // Best-effort preflight: record a probe failure as a warning and
      // attempt sign-in anyway instead of throwing preflight.detail.
      const preflight = await probeControlHealth();
      setHealth(preflight);
      if (!preflight.ok) {
        setProbeWarning(`${preflight.detail} Trying sign-in anyway — the probe can fail on slow or waking hosts while sign-in still works.`);
      }
      await authenticate(method === "token" ? { token: token.trim() } : { username: username.trim(), password });
      // A successful sign-in lands on the live control plane, not the demo overview.
      await dashboardStore.refreshLive();
      navigate("live");
    } catch (err) {
      setError(describeSignInError(err));
    } finally { setBusy(false); }
  };

  return <main className="product-auth">
    <header className="product-container flex flex-wrap items-center justify-between gap-2 py-4"><Brand /><div className="flex items-center gap-2"><ThemeControl /><LanguageControl /></div></header>
    <div className="product-auth-content">
    <div className="product-auth-form space-y-4">
      <div className="space-y-3">
        <h1>{t("Connect to AI Bridge")}</h1>
      </div>
      <FrostedGlass className="rounded-2xl border border-[color:var(--product-line)] bg-[var(--product-surface)]/70 p-1">
        <JXCardContent>
          <div className="space-y-4 p-3 sm:p-4">
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("Sign-in method")}>
              <JXButton color={method === "token" ? "primary" : "neutral"} variant={method === "token" ? "contained" : "outlined"}
                aria-pressed={method === "token"} onClick={() => { setMethod("token"); setError(""); }} startIcon={<KeyRound className="h-4 w-4" />}>{t("Admin token")}</JXButton>
              <JXButton color={method === "password" ? "primary" : "neutral"} variant={method === "password" ? "contained" : "outlined"}
                aria-pressed={method === "password"} onClick={() => { setMethod("password"); setError(""); }} startIcon={<UserRound className="h-4 w-4" />}>{t("Account")}</JXButton>
            </div>
            <div lang="en" dir="ltr" className="rounded-lg border border-[color:var(--product-line)] bg-[var(--product-raised)]/40 px-3 py-2 text-xs text-[color:var(--product-text-tertiary)]">
              <p>Control plane: <code className="text-[color:var(--product-text-secondary)]">{apiOrigin}</code></p>
              <p className="mt-1" role="status">
                {probing ? "Checking API… free-tier hosts can take up to a minute to wake." : health?.ok
                  ? `API reachable${health.version ? ` · v${health.version}` : ""}`
                  : (health?.detail || "API unreachable")}
              </p>
            </div>
            {error && <div lang="en" dir="ltr"><JXAlert severity="error" title="Unable to sign in" description={error} /></div>}
            {!probing && health && !health.ok && !error && !probeWarning && (
              <div lang="en" dir="ltr"><JXAlert severity="warning" title="Control plane unreachable" description={health.detail} /></div>
            )}
            {probeWarning && (
              <div lang="en" dir="ltr"><JXAlert severity="warning" title="Control plane probe failed" description={probeWarning} /></div>
            )}
            <form className="space-y-4" onSubmit={submit}>
              {method === "token" ? <>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <JXTextField label={t("Admin token")} type={showToken ? "text" : "password"} value={token} onChange={setToken}
                      required autoComplete="off" clearable={false} />
                  </div>
                  <JXButton type="button" variant="outlined" color="neutral" size="sm" className="mt-6 min-h-11 shrink-0"
                    aria-pressed={showToken} aria-label={showToken ? "Hide admin token" : "Show admin token"}
                    title={showToken ? "Hide admin token" : "Show admin token"}
                    onClick={() => setShowToken((prev) => !prev)}>
                    {showToken ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </JXButton>
                </div>
                <p lang="en" dir="ltr" className="text-xs text-[color:var(--product-text-tertiary)]">Use the AI_BRIDGE_ADMIN_TOKEN configured on your server.</p></> :
                <>
                  <JXTextField label={t("Username")} value={username} onChange={setUsername} required autoComplete="username" clearable={false} />
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <JXTextField label={t("Password")} type={showPassword ? "text" : "password"} value={password} onChange={setPassword} required autoComplete="current-password" clearable={false} />
                    </div>
                    <JXButton type="button" variant="outlined" color="neutral" size="sm" className="mt-6 min-h-11 shrink-0"
                      aria-pressed={showPassword} aria-label={showPassword ? "Hide password" : "Show password"}
                      title={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword((prev) => !prev)}>
                      {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                    </JXButton>
                  </div>
                </>}
              <JXButton type="submit" fullWidth loading={busy} loadingLabel={t("Signing in…")}
                disabled={busy || probing}
                endIcon={<ArrowRight className="h-4 w-4 rtl:rotate-180" />}>{t("Sign in")}</JXButton>
            </form>
            {health && !health.ok && (
              <JXButton fullWidth variant="outlined" color="neutral" onClick={() => {
                setProbing(true);
                setProbeWarning("");
                probeControlHealth().then((result) => { setHealth(result); setProbing(false); });
              }}>Retry connection check</JXButton>
            )}
            {ssoConfigured && <JXButton fullWidth color="neutral" variant="outlined" onClick={() => api.oidcLogin()}>{t("Sign in with your identity provider")}</JXButton>}
            <div className="space-y-3 border-t border-[color:var(--product-line)] pt-5">
              <p className="text-xs leading-relaxed text-[color:var(--product-text-tertiary)]">
                Just looking around?{" "}
                <button type="button" onClick={() => navigate("overview")}
                  className="font-medium text-indigo-300 underline decoration-indigo-300/50 underline-offset-2 hover:text-indigo-200">
                  {t("Explore demo workspace")}
                </button>
              </p>
              <p lang="en" dir="ltr" className="text-xs leading-relaxed text-[color:var(--product-text-tertiary)]">Demo workspace — simulated data, not a real fleet.</p>
            </div>
          </div>
        </JXCardContent>
      </FrostedGlass>
      <p lang="en" dir="ltr" className="text-xs leading-relaxed text-[color:var(--product-text-tertiary)]">Credentials are kept for this browser session, not saved permanently.</p>
    </div>
    <div className="product-auth-art"><BrandArt /></div>
    </div>
  </main>;
};

export default LoginView;
