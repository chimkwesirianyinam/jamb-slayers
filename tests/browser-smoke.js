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

    await page.locator("#navGetStarted").click();
    await page.locator("#studentName").fill("Browser Test Candidate");
    await page.locator("#continueName").click();
    await page.locator('input[name="track"][value="Medical"]').check();
    await page.locator("#continueField").click();
    await page.locator("#beginMock").click();

    await page.locator("#subjectTabs .subject-tab").first().waitFor();
    const tabs = page.locator("#subjectTabs .subject-tab");
    assert.equal(await tabs.count(), 4, "Expected four subject tabs");
    const tabText = await tabs.allTextContents();
    assert.match(tabText[0], /English[\s\S]*0\/60 answered/);
    for (const subject of ["Physics", "Chemistry", "Biology"]) {
      const text = tabText.find(item => item.includes(subject));
      assert.ok(text, "Missing " + subject + " tab");
      assert.match(text, /0\/40 answered/);
    }

    // Confirm switching subjects updates the local question numbering.
    await tabs.nth(1).click();
    assert.match(await page.locator("#num").textContent(), /Question 1 of 40/);
    await tabs.nth(0).click();
    assert.match(await page.locator("#num").textContent(), /Question 1 of 60/);

    // Submission must open the custom confirmation and then show results.
    await page.locator("#submit").click();
    await page.locator("#popupBackdrop.open").waitFor();
    assert.match(await page.locator("#popupTitle").textContent(), /Submit your mock/i);
    await page.locator("#popupConfirm").click();
    await page.locator("#results:not(.hidden)").waitFor({ timeout: 10000 });
    assert.ok((await page.locator("#percent").textContent()).includes("/400"));

    assert.deepEqual(pageErrors, [], "Browser console page errors were detected");
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/mock-results.png", fullPage: true });
    console.log("PASS: site loaded, four tabs and local counts verified, submit opened custom confirmation, results rendered.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
