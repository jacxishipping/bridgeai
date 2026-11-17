import React from "react";
import { createRoot } from "react-dom/client";
import { JXThemeProvider } from "@jacxishippingorg/jx-ui-react";
import "./tailwind.css";
import App from "./App";
import { consumeIdentityRedirectAsync } from "./api";
import { dashboardStore } from "./state/dashboardStore";
import { applySavedDensity } from "./DensityControl";
import { initializeLanguage } from "./i18n";
import { initializeTheme } from "./ThemeControl";

// Wave 5A: the OIDC exchange is awaited before first render. The old
// main.tsx called the sync consumeIdentityRedirect() wrapper, which
// stripped the code from the URL and fired the exchange in the
// background — the app could render (and route) before the session
// token existed. Awaiting here means the live view's /api/auth/me
// check sees the exchanged session on first paint.
void (async () => {
  if (await consumeIdentityRedirectAsync()) dashboardStore.syncRoute();
  applySavedDensity();
  initializeLanguage();
  initializeTheme();

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <JXThemeProvider defaultMode="dark" storageKey="ai_bridge_theme">
        <App />
      </JXThemeProvider>
    </React.StrictMode>
  );
})();
