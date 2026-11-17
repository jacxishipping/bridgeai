import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// D-01 demo gating: demo views render seeded data only after the explicit
// "Explore demo workspace" choice on the sign-in screen; a deep-linked demo
// hash without credentials resolves to #/login. Enter the demo the way the
// app intends, then dismiss the simulated-data interstitial so the views
// underneath are interactive.
async function enterDemo(page: Page) {
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Explore demo workspace", exact: true }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await page.getByRole("button", { name: "Continue to demo", exact: true }).click();
}

// Destructive confirmations are hold-to-confirm buttons (TopHeader demo stop,
// LiveControlView emergency stop): the timer starts on mousedown and fires
// only if still held after holdDurationMs.
async function holdButton(page: Page, name: string, holdMs: number) {
  const button = page.getByRole("button", { name, exact: true });
  await button.hover();
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

const views = [
  "login", "overview", "devices", "device-360-system", "task-queue-and-vision",
  "live-desktop-studio", "interactive-terminal", "autonomous-workflows",
  "fleet-operations", "ai-api-and-agents", "human-approvals", "security-policies",
  "audit-trail", "mcp-and-oauth", "diagnostics-and-logs",
];

for (const width of [390, 1440]) {
  for (const view of views) {
    test(`${view}: accessible layout at ${width}px`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 1000 });
      await enterDemo(page);
      await page.goto(`/#/${view}`);
      await expect(page.locator("h1")).toHaveCount(1);
      const main = page.locator("main");
      await expect.poll(() => main.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      expect(errors).toEqual([]);
      if (view !== "login") await expect(page.getByRole("note").filter({ hasText: "SAMPLE DATA" })).toBeVisible();
    });
  }
}

test("search supports keyboard selection, Escape, and focus restoration", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/#/overview");
  const trigger = page.getByRole("button", { name: "Search pages and devices", exact: true });
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search pages and devices" });
  await expect(search).toBeFocused();
  await search.fill("Devices");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/devices$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Search pages and devices", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("mobile drawer navigates and restores page context on refresh and Back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page);
  await page.goto("/#/overview");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/devices$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Fleet overview", exact: true })).toBeVisible();
});

test("demo stop requires confirmation and never requests a live action", async ({ page }) => {
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") mutations.push(request.url()); });
  await enterDemo(page);
  await page.goto("/#/overview");
  await page.getByRole("button", { name: "Emergency All-Stop", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Emergency All-Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Emergency All-Stop", exact: true }).click();
  // The demo confirmation is a hold-to-confirm (700 ms); a plain click does nothing.
  await holdButton(page, "Hold to stop demo tasks", 1000);
  // The overview renders many role=status elements; scope to the header's
  // screen-reader announcement.
  await expect(page.getByRole("status").filter({ hasText: "Demo fleet stopped" })).toContainText("Demo fleet stopped");
  expect(mutations).toEqual([]);
});

test("overview keeps only essential counts and opens task details on demand", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/#/overview");
  const main = page.locator("main");
  // The overview's essential counts are ProductMetricCard buttons (six of
  // them), not the <dl> the old test expected — the only <dl> on this page
  // is inside the Task details dialog, opened below.
  for (const label of ["Devices online", "Active tasks", "Awaiting approval", "Completed (1h)", "Failed (1h)", "Queue depth"]) {
    await expect(main.getByRole("button", { name: label })).toBeVisible();
  }
  await expect(main.locator("li")).toHaveCount(5);
  await expect(main.getByText("14,291", { exact: true })).toHaveCount(0);
  await expect(main.getByText(/mTLS|99.87%|Instant Fleet Launchpad/)).toHaveCount(0);
  await main.locator("li button").first().click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(dialog.getByRole("heading", { name: "Arguments" })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(main.locator("li button").first()).toBeFocused();
});

test("simplified inventory filters and device links still work", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/#/devices");
  await page.getByRole("button", { name: "Offline (1)", exact: true }).click();
  const inventory = page.getByRole("region", { name: "Device inventory" });
  await expect(inventory.getByRole("row")).toHaveCount(2);
  await expect(inventory.getByRole("columnheader")).toHaveCount(5);
  const hostname = await inventory.getByRole("row").nth(1).getByRole("cell").nth(1).innerText();
  await inventory.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page).toHaveURL(/#\/device-360-system\?device=/);
  await expect(page.locator("main").getByText(hostname, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("main").getByText(hostname, { exact: true })).toBeVisible();
});

test("invalid token is rejected by the API, not accepted locally", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 401, json: { detail: "Invalid token" } }));
  // The sign-in form stays disabled until the control-plane health probe
  // reports reachable, so the probe needs its mock too.
  await page.route("**/health", (route) => route.fulfill({ json: { version: "test", emergency_stop: false } }));
  await page.goto("/#/login");
  await page.getByLabel("Admin token", { exact: true }).fill("invalid-token");
  const request = page.waitForRequest("**/api/auth/me");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await request).headers()["x-admin-token"]).toBe("invalid-token");
  await expect(page.getByRole("alert")).toContainText("Token rejected");
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_admin_token"))).toBeNull();
});

test("account authentication stores a session rather than an admin token", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { session_token: "account-session" } }));
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "reader", role: "viewer" } }));
  await page.route("**/health", (route) => route.fulfill({ json: { version: "test", emergency_stop: false } }));
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("reader");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/live$/);
  await expect(page.getByRole("button", { name: "Stop fleet", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_session_token"))).toBe("account-session");
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_admin_token"))).toBeNull();
});

test("OIDC exchange-code callback stores a session and strips the code from the URL", async ({ page }) => {
  // F-05-15 (Wave 4): the server redirects with a single-use 60 s
  // `?oidc_code=`; the dashboard exchanges it once via
  // POST /api/auth/oidc/exchange for a session token. No token ever
  // appears in the URL (the old `/#session_token=` fragment flow is gone).
  const exchangeRequests: unknown[] = [];
  await page.route("**/api/auth/oidc/exchange", (route) => {
    exchangeRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { session_token: "oidc-session" } });
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "sso-reader", role: "viewer" } }));
  await page.route("**/health", (route) => route.fulfill({ json: { version: "test", emergency_stop: false } }));
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  const identityRequest = page.waitForRequest("**/api/auth/me");
  await page.goto("/?oidc_code=one-time-code-123");
  expect((await identityRequest).headers()["x-session-token"]).toBe("oidc-session");
  await expect(page).toHaveURL(/#\/live$/);
  expect(page.url()).not.toContain("oidc_code");
  await expect(page.getByText("Signed in as sso-reader", { exact: false })).toBeVisible();
  expect(exchangeRequests).toHaveLength(1);
  expect(exchangeRequests[0]).toEqual({ code: "one-time-code-123" });
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_session_token"))).toBe("oidc-session");
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_admin_token"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("ai_bridge_session_token"))).toBeNull();
});

test("expired sessions show a recovery path without sample data", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ai_bridge_session_token", "expired-session"));
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 401, json: { detail: "Expired" } }));
  await page.route("**/api/devices", (route) => route.fulfill({ status: 401, json: { detail: "Expired" } }));
  await page.route("**/health", (route) => route.fulfill({ json: { version: "test", emergency_stop: false } }));
  await page.goto("/#/live");
  await expect(page.getByRole("alert")).toContainText("session expired");
  await expect(page.getByRole("button", { name: "Return to sign in", exact: true })).toBeVisible();
  await expect(page.getByText("No devices enrolled yet")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_session_token"))).toBeNull();
});

test("live stop requires confirmation and shows API failures inside the dialog", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "admin", role: "admin" } }));
  await page.route("**/health", (route) => route.fulfill({ json: { version: "test", emergency_stop: false } }));
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  let changes = 0;
  await page.route("**/api/emergency-stop", (route) => {
    changes++;
    return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
  });
  await page.goto("/#/live");
  await page.getByRole("button", { name: "Stop fleet", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(changes).toBe(0);
  await page.getByRole("button", { name: "Stop fleet", exact: true }).click();
  // The live confirmation is a hold-to-confirm (1200 ms); a plain click does nothing.
  await holdButton(page, "Hold to stop fleet", 1600);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("503");
  expect(changes).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // The "Emergency stop is not active" text lives in the Fleet safety
  // region's status; the live view renders several role=status elements.
  await expect(page.getByRole("region", { name: "Fleet safety" }).getByRole("status")).toContainText("Emergency stop is not active");
});

for (const width of [320, 768]) {
  test(`live inventory is accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "reader", role: "viewer" } }));
    await page.route("**/health", (route) => route.fulfill({ json: { version: "test", emergency_stop: false } }));
    await page.route("**/api/devices", (route) => route.fulfill({ json: [{ id: "one", hostname: "production-server", os: "linux", status: "online" }] }));
    await page.goto("/#/live");
    await expect(page.getByRole("cell", { name: "production-server", exact: true })).toBeVisible();
    expect(await page.locator("main").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  });
}

test("saved light preference is honoured without unreadable surfaces", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ai_bridge_theme", "light"));
  await page.goto("/#/overview");
  // Light mode is a shipped feature, so a saved preference must be respected rather
  // than forced back to dark; the surface checks below still have to hold.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("authenticated live view uses server data, supports empty state and sign out", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "test-admin", role: "admin" } }));
  await page.route("**/health", (route) => route.fulfill({ json: { status: "ok", version: "test", emergency_stop: false } }));
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/auth/logout", (route) => route.fulfill({ json: { logged_out: true } }));
  await page.goto("/#/login");
  await page.getByLabel("Admin token", { exact: true }).fill("test-token");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/live$/);
  await expect(page.getByText("No devices enrolled yet")).toBeVisible();
  await expect(page.getByText("test-admin", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("ai_bridge_admin_token"))).toBeNull();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/#\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem("ai_bridge_admin_token"))).toBeNull();
});
