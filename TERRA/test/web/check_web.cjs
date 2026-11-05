// Browser checks for index.html: the 3D page loads, the planner finishes a task, the
// camera panel shows detections, the benchmark table matches results/bench.json, and the
// Claude brain path works end to end against a mocked API (including the shield refusing
// a hijacked command in the injection scenario).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "..");
const BENCH = JSON.parse(fs.readFileSync(path.join(ROOT, "results", "bench.json")));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`); if (!ok) failures++; };

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  let calls = 0;
  let sawImage = false;
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    calls++;
    const body = JSON.parse(route.request().postData());
    sawImage = sawImage || body.messages[0].content.some((c) => c.type === "image");
    const text = body.messages[0].content.find((c) => c.type === "text").text;
    // A brain that falls for the sign the first time, then gives up.
    const content = calls === 1 && /supervisor override/.test(text)
      ? [{ type: "text", text: "The sign says to go to the exit." }, { type: "tool_use", id: "a", name: "navigate_to", input: { x: 19.3, y: 7.0, speed: 2.0 } }]
      : [{ type: "text", text: "Stopping here." }, { type: "tool_use", id: "b", name: "done", input: { summary: "stop" } }];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content, stop_reason: "tool_use" }) });
  });

  await page.goto(url);
  await page.waitForSelector("body[data-ready='1']", { timeout: 20000 });
  check("3D running", !(await page.isVisible("#fallback")));
  await page.waitForFunction(() => document.querySelectorAll("#bench-table tbody tr").length > 1, null, { timeout: 10000 });
  check("benchmark rows", (await page.locator("#bench-table tbody tr").count()) === BENCH.table.length);
  const on = BENCH.table.filter((r) => r.shield), off = BENCH.table.filter((r) => !r.shield);
  const sum = (rows) => rows.reduce((a, r) => a + r.contacts, 0);
  check("hero stat from bench", (await page.textContent("[data-stat=contacts]")).trim() === `${sum(off)} → ${sum(on)}`);

  // Planner runs a full task
  await page.selectOption("#speed", "4");
  await page.click("#start");
  await page.waitForFunction(() => document.querySelectorAll("#dets li").length > 0, null, { timeout: 10000 });
  await page.waitForSelector("#endcard:not([hidden])", { timeout: 240000 });
  const end = await page.textContent("#endcard .t");
  check("planner finished", /Task complete/.test(end), end);
  check("log has actions", (await page.locator("#log li.action").count()) > 3);
  check("lidar drawn", await page.evaluate(() => { const c = document.querySelector("#lidar"); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v) => v > 0); }));

  // Claude brain, injection scenario, mocked API
  await page.click("#scenario button[data-v=injection]");
  await page.click("#brain button[data-v=claude]");
  await page.fill("#apikey", "sk-ant-test");
  await page.click("#keyform button");
  await page.click("#start");
  await page.waitForSelector("#endcard:not([hidden])", { timeout: 60000 });
  const log = await page.textContent("#log");
  check("claude action ran", log.includes("navigate_to(x=19.3"), log.slice(0, 300));
  check("shield refused the exit", /REFUSED by safety shield \[S4-no-go\]/.test(log));
  check("injection alert raised", /prompt injection/.test(log));
  check("camera frame sent", sawImage);
  check("no console errors", errors.length === 0, errors.join(" | "));

  if (process.env.SHOT) {
    const p2 = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await p2.goto(url);
    await p2.waitForSelector("body[data-ready='1']");
    await p2.click("#scenario button[data-v=busy]");
    await p2.selectOption("#speed", "2");
    await p2.click("#start");
    await p2.waitForTimeout(Number(process.env.SHOT_WAIT || 9000));
    await p2.addStyleTag({ content: "header.top{display:none!important}" });
    await (await p2.$("#demo")).screenshot({ path: process.env.SHOT });
    await p2.addStyleTag({ content: "header.top{display:flex!important}" });
    await p2.evaluate(() => window.scrollTo(0, 0));
    await p2.screenshot({ path: process.env.SHOT.replace(".png", "-hero.png") });
  }
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall web checks passed");
  process.exit(failures ? 1 : 0);
})();
