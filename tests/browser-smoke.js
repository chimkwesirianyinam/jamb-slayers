const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  try {
    const url = process.env.TARGET_URL || "https://jamb-slayers.onrender.com";
    let loaded = false;
    let lastError;
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        if (response && response.ok()) { loaded = true; break; }
        lastError = new Error("HTTP response: " + (response?.status() ?? "none"));
      } catch (error) { lastError = error; }
      await page.waitForTimeout(10000);
    }
    assert.ok(loaded, "Website did not become reachable: " + (lastError?.message || "unknown error"));

    await page.getByRole("heading", { name: /Prepare with purpose/i }).waitFor({ state: "visible" });
    await page.locator("#navGetStarted").click();
    await page.getByRole("heading", { name: /Welcome to JAMB Slayers/i }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Create account/i }).click();

    for (const selector of ["#signupSurname", "#signupFirstName", "#signupUsername", "#signupEmail", "#signupPassword", "#signupTarget"]) {
      await page.locator(selector).waitFor({ state: "visible" });
    }
    await page.getByRole("button", { name: /Continue with Google/i }).waitFor({ state: "visible" });

    // Exercise the field-selection -> Start Mock instructions navigation without starting a live exam.
    await page.evaluate(() => {
      for (const id of ["home", "features", "namePage", "fieldPreview", "exam", "results"]) {
        document.getElementById(id)?.classList.add("hidden");
      }
      document.getElementById("setup")?.classList.remove("hidden");
    });
    await page.getByRole("button", { name: "Medical Field" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: /Medical Field/ }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Start Mock/ }).waitFor({ state: "visible" });
    await page.getByText(/90 minutes for the complete mock/i).waitFor({ state: "visible" });
    await page.locator("#previewBack").click();
    await page.getByRole("button", { name: "Engineering Field" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: /Engineering Field/ }).waitFor({ state: "visible" });
    await page.getByText(/Mathematics/).waitFor({ state: "visible" });

    assert.deepEqual(pageErrors, [], "Browser JavaScript page errors were detected");
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/student-account-screen.png", fullPage: true });
    console.log("PASS: deployed site loaded, account navigation worked, all registration fields and Google sign-in control rendered.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
