// 最小 CDP クライアント (Node 22 のグローバル WebSocket を使用)
const BASE = process.env.E2E_URL || "http://localhost:5173/";
const DBG = "http://localhost:9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`${DBG}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("no CDP page target");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(async()=>{ ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
    return r.result.value;
  }
}

const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
};

const ws = new WebSocket(await getWsUrl());
await new Promise((r) => (ws.onopen = r));
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    logs.push("EXCEPTION: " + JSON.stringify(m.params.exceptionDetails.exception));
  }
});

await cdp.send("Page.navigate", { url: BASE });
await sleep(1500);

// 1. リージョン読み込み待ち
let loaded = false;
for (let i = 0; i < 60; i++) {
  loaded = await cdp.eval("return !!(window.__colony && window.__colony.regionLoaded)");
  if (loaded) break;
  await sleep(1000);
}
ok("リージョン(建物/道路/地形)読み込み完了", loaded);

const counts = await cdp.eval("return window.__colony.counts");
ok("建物メッシュ頂点あり", (counts.buildings || 0) > 1000, `buildings=${counts.buildings}`);
ok("道路メッシュ頂点あり", (counts.roads || 0) > 100, `roads=${counts.roads}`);
ok("地形メッシュあり", !!counts.terrain, `terrain=${counts.terrain || 0}`);

// 2. ジオコーディング
const hits = await cdp.eval(`
  const h = await window.__colony.geocode("Coit Tower San Francisco");
  return h.map(x=>({label:x.label.slice(0,40), ...x.lngLat}));
`);
ok("Nominatim ジオコーディング", Array.isArray(hits) && hits.length > 0, `${hits[0]?.label ?? "なし"}`);

// 3. ルート探索 + ルートライン描画
let routeInfo = null;
if (hits && hits.length) {
  await cdp.eval(`
    await window.__colony.setDestination({lng:${hits[0].lng}, lat:${hits[0].lat}}, "Coit Tower");
  `);
  for (let i = 0; i < 20; i++) {
    routeInfo = await cdp.eval(`
      const r = window.__colony.route;
      const c = window.__colony.counts;
      return r ? {dist:r.distance, dur:r.duration, steps:r.steps.length, coords:r.coords.length, routeVerts:(c.route||0)} : null;
    `);
    if (routeInfo) break;
    await sleep(1000);
  }
}
ok("OSRM ルート探索", routeInfo && routeInfo.coords > 1,
   routeInfo ? `${(routeInfo.dist/1000).toFixed(2)}km / ${routeInfo.steps}ステップ` : "ルートなし");
ok("3D ルートライン描画", routeInfo && routeInfo.routeVerts > 0, `routeVerts=${routeInfo?.routeVerts ?? 0}`);

// 4. 下部カード「案内開始」ボタン表示
const hasStartBtn = await cdp.eval(`
  return !!document.querySelector('.bottom-card [data-a="start"]');
`);
ok("下部カードに『案内開始』表示", hasStartBtn);

// 5. ナビ開始 → オートパイロット走行 → 案内バナー
if (hasStartBtn) {
  await cdp.eval(`document.querySelector('.bottom-card [data-a="start"]').click();`);
  await sleep(3500);
  const navState = await cdp.eval(`
    const car = window.__colony.car;
    return {
      mode: car.mode, speed: +car.speed.toFixed(1),
      banner: (document.querySelector('.turn-banner') && !document.querySelector('.turn-banner').classList.contains('hidden')),
      bannerText: document.querySelector('.turn-banner .dist')?.textContent || "",
      navInfo: (document.querySelector('.bottom-card .eta')?.textContent) || "",
    };
  `);
  ok("案内開始でオートパイロット走行", navState.mode === "autopilot" && navState.speed > 0,
     `mode=${navState.mode} speed=${navState.speed}m/s`);
  ok("ターンバイターン案内バナー表示", navState.banner, `"${navState.bannerText}" / 残り ${navState.navInfo}`);
}

// 6. 表示モード切替
const modeSwitch = await cdp.eval(`
  const f0 = [window.__colony.colony.uForward.value.x, window.__colony.colony.uForward.value.y];
  document.querySelectorAll('.fab')[0].click();  // view mode fab
  await new Promise(r=>setTimeout(r,600));
  const f1 = [window.__colony.colony.uForward.value.x, window.__colony.colony.uForward.value.y];
  return {f0, f1, changed: (f0[0]!==f1[0]||f0[1]!==f1[1])};
`);
ok("表示モード切替でforward方向が変化", modeSwitch.changed,
   `${modeSwitch.f0.map(n=>n.toFixed(2))} -> ${modeSwitch.f1.map(n=>n.toFixed(2))}`);

// スクリーンショット
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("/tmp/e2e-final.png", Buffer.from(shot.data, "base64"));
console.log("\nスクリーンショット: /tmp/e2e-final.png");

// コンソールエラー
const errs = logs.filter((l) => /EXCEPTION|Uncaught|TypeError|is not a function|undefined is not/.test(l));
ok("実行時例外なし", errs.length === 0, errs.slice(0, 3).join(" | "));

console.log("\n" + "=".repeat(50));
const passed = results.filter((r) => r.pass).length;
console.log(`結果: ${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
