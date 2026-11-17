import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { username: "Reviewer", role: "admin" } }));
  await page.route("**/health", (route) => route.fulfill({ json: { emergency_stop: false } }));
  await page.route("**/api/devices", (route) => route.fulfill({ json: [
    { id: "alpha", name: "Production", status: "online" },
    { id: "beta", name: "Build agent", status: "offline" },
  ] }));
});

test("desktop shell and inventory use compact dimensions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The overview is a demo view (D-01): enter via the sign-in screen's
  // explicit demo choice, then dismiss the simulated-data interstitial.
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Explore demo workspace", exact: true }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await page.getByRole("button", { name: "Continue to demo", exact: true }).click();
  await page.goto("/#/overview");
  await expect(page.locator(".product-topbar")).toHaveCSS("min-height", "56px");
  // The sidebar is lg:w-56 (224 px) in the shipped shell; the old 208 px
  // expectation never matched this app (no density rule changes its width).
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCSS("width", "224px");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "20px");
  // Compact controls honour --product-control-height (34 px). The "View
  // devices" header CTA is a MagneticButton — the app-wide primary-CTA
  // pattern, deliberately 52 px — so it is not a compact control; assert
  // the height of a real compact control instead (the Recent tasks
  // "View all" JXButton, .product-button).
  const button = page.getByRole("button", { name: "View all", exact: true });
  expect((await button.boundingBox())!.height).toBeLessThanOrEqual(36);
  // Every .product-surface on the overview is a button wrapper with p-0!
  // by design (stat cards, nav cards — the inner button supplies p-4), so
  // the 14 px surface token never determines an overview element's padding.
  // Assert it where a plain surface exists: the AI/API view's JXCard,
  // which carries .product-surface with no padding override.
  await page.goto("/#/ai-api-and-agents");
  await expect(page.locator(".product-surface", { has: page.getByText("Connect your AI") }).first()).toHaveCSS("padding", "14px");

  await page.goto("/#/live");
  await expect(page.getByRole("button", { name: "Production", exact: true })).toBeVisible();
  await expect(page.getByLabel("Find device")).toHaveCSS("min-height", "34px");
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Production", exact: true }) });
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

for (const setup of [
  { name: "narrow screen", viewport: { width: 390, height: 900 }, hasTouch: false },
  { name: "large touch screen", viewport: { width: 1440, height: 900 }, hasTouch: true },
]) {
  test.describe(setup.name, () => {
    test.use({ viewport: setup.viewport, hasTouch: setup.hasTouch });
    test("keeps generous interactive targets without page overflow", async ({ page }) => {
      await page.goto("/#/live");
      await expect(page.getByRole("button", { name: "Production", exact: true })).toBeVisible();
      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await page.getByLabel("Find device").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await page.getByRole("button", { name: "Devices", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });
  });
}
