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
    await page.locator("#fieldPreviewSubjects").waitFor({ state: "visible" });
    assert.match(await page.locator("#fieldPreviewSubjects").textContent(), /Mathematics/);

    // Check dashboard sections and confirm the admin uploader is not exposed to signed-out visitors.
    await page.evaluate(() => {
      for (const id of ["home", "features", "namePage", "setup", "customPractice", "fieldPreview", "exam", "results"]) {
        document.getElementById(id)?.classList.add("hidden");
      }
      document.getElementById("dashboard")?.classList.remove("hidden");
    });
    await page.getByRole("heading", { name: /JAMB News & Mocks/i }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: /Custom CBT Practice/i }).waitFor({ state: "visible" });
    await page.locator("#publishedMocks").waitFor({ state: "visible" });
    assert.ok(await page.locator("#adminMockPanel").evaluate(node => node.classList.contains("hidden")),
      "Admin mock uploader must remain hidden when signed out");

    // The API must reject mock access and publishing attempts without a Firebase bearer token.
    const apiBase = "https://jamb-slayers-auth-api.onrender.com";
    const accessResponse = await page.request.get(apiBase + "/api/mocks/access");
    assert.equal(accessResponse.status(), 401, "Mock admin access endpoint must require authentication");
    const publishResponse = await page.request.post(apiBase + "/api/mocks", {
      data: { title: "Unauthorised test", field: "Medical", questions: [] }
    });
    assert.equal(publishResponse.status(), 401, "Mock publishing endpoint must reject unauthenticated requests");

    assert.deepEqual(pageErrors, [], "Browser JavaScript page errors were detected");
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/student-account-screen.png", fullPage: true });
    console.log("PASS: deployed site, field Next flow, dashboard sections, hidden admin panel and unauthenticated mock API protection.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
