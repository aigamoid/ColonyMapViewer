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
  const h = await window.__colony.geocode("東京タワー");
  return h.map(x=>({label:x.label.slice(0,40), ...x.lngLat}));
`);
ok("Nominatim ジオコーディング", Array.isArray(hits) && hits.length > 0, `${hits[0]?.label ?? "なし"}`);

// 3. ルート探索 + ルートライン描画
let routeInfo = null;
if (hits && hits.length) {
  await cdp.eval(`
    await window.__colony.setDestination({lng:${hits[0].lng}, lat:${hits[0].lat}}, "東京タワー");
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

// 6. 「終了」ボタンでナビが確実に終わる (地図クリック判定に食われないこと)
const ended = await cdp.eval(`
  const btn = document.querySelector('.bottom-card [data-a="end"]');
  if (!btn) return { hadBtn:false };
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  const opt = {bubbles:true, clientX:cx, clientY:cy};
  btn.dispatchEvent(new PointerEvent('pointerdown', opt));
  btn.dispatchEvent(new PointerEvent('pointerup', opt));
  btn.click();
  window.dispatchEvent(new PointerEvent('pointerup', opt));
  await new Promise(r=>setTimeout(r,1200));
  const card = document.querySelector('.bottom-card');
  return {
    hadBtn: true,
    cardHidden: !card || card.classList.contains('hidden'),
    route: !!window.__colony.route,
    mode: window.__colony.car.mode,
  };
`);
ok("『終了』でナビが終了しカードが消える",
   ended.hadBtn && ended.cardHidden && !ended.route,
   `card非表示=${ended.cardHidden} route=${ended.route} mode=${ended.mode}`);

// 7. 表示モード切替: 北向き / 進行方向 が実際に一致するか
// forward は目標へ補間するので、収束するまでポーリングする
const deg = (r) => +((r * 180) / Math.PI).toFixed(1);
const fwdDeg = () =>
  cdp.eval(`
    const v = window.__colony.colony.uForward.value;
    return Math.atan2(v.x, v.y) * 180 / Math.PI;
  `);
const cycleTo = async (badge) => {
  for (let i = 0; i < 4; i++) {
    const cur = await cdp.eval(`return document.querySelectorAll('.fab')[0].textContent;`);
    if (cur.includes(badge)) return true;
    await cdp.eval(`document.querySelectorAll('.fab')[0].click();`);
    await sleep(400);
  }
  return false;
};
const settleUntil = async (pred) => {
  let last = null;
  for (let i = 0; i < 25; i++) {
    last = await fwdDeg();
    if (pred(last)) return last;
    await sleep(400);
  }
  return last;
};

await cycleTo("N");
const northDeg = await settleUntil((d) => Math.abs(d) < 2);
ok("ノースアップが真北を向く", Math.abs(northDeg) < 2, `forward方位=${northDeg.toFixed(1)}°`);

await cycleTo("車");
const carHeadingDeg = await cdp.eval(`
  const h = window.__colony.car.heading;
  return Math.atan2(Math.sin(h), Math.cos(h)) * 180 / Math.PI;
`);
const headDeg = await settleUntil((d) => Math.abs(d - carHeadingDeg) < 4);
ok(
  "車アップが進行方向と一致",
  Math.abs(headDeg - carHeadingDeg) < 4,
  `forward=${headDeg.toFixed(1)}° / car.heading=${deg((carHeadingDeg * Math.PI) / 180)}°`,
);

// 8. 地名・施設ラベル
const labelInfo = await cdp.eval(`
  const els = [...document.querySelectorAll('.label')].filter(e => e.style.display !== 'none');
  return { n: els.length, sample: els.slice(0,3).map(e=>e.textContent) };
`);
ok("地名・施設ラベル表示", labelInfo.n > 5, `${labelInfo.n}件 例: ${labelInfo.sample.join(" / ")}`);

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
