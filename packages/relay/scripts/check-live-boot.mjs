import { chromium } from "playwright";

const url = process.argv[2] || "https://my.parthaunnava.com/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
const state = await page.evaluate(() => ({
  publicMeta: document.querySelector('meta[name="ground-board-public"]')?.getAttribute("content"),
  appClass: document.getElementById("app")?.className,
  gateDisplay: document.getElementById("gate")?.style.display,
  publicTagHidden: document.getElementById("public-tag")?.hidden,
  title: document.getElementById("top-title")?.textContent,
}));
console.log(JSON.stringify({ url, state, errors }, null, 2));
await browser.close();
