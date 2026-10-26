import { chromium } from "playwright";

const url = process.argv[2] || "https://my.parthaunnava.com/";
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];

const browser = await chromium.launch();
const errors = [];

for (const vp of viewports) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  page.on("pageerror", (e) => errors.push(`${vp.name}: ${e.message}`));
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  const headerUnlock = await page.isVisible("#lm-unlock-btn");
  const appOn = await page.evaluate(() => document.getElementById("app")?.classList.contains("on"));
  await page.click("#lm-unlock-btn");
  const gateVisible = await page.evaluate(() => {
    const g = document.getElementById("gate");
    return g && g.style.display === "flex";
  });
  const gateInput = await page.isVisible("#key");
  await page.click("#gate-preview");
  const backOnApp = await page.evaluate(() => document.getElementById("app")?.classList.contains("on"));
  console.log(
    JSON.stringify({ viewport: vp.name, appOn, headerUnlock, gateOpens: gateVisible && gateInput, backToPreview: backOnApp }),
  );
  await page.close();
}

await browser.close();
if (errors.length) {
  console.error("errors", errors);
  process.exit(1);
}
