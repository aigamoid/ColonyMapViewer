import "./style.css";
import type { GeocodeHit } from "./routing";

export type ViewModeId = "north" | "destination" | "heading";

export interface UICallbacks {
  onSearch: (query: string) => Promise<GeocodeHit[]>;
  onPickDestination: (hit: GeocodeHit) => void;
  onStartNav: () => void;
  onCancelRoute: () => void;
  onEndNav: () => void;
  onRecenter: () => void;
  onToggleGps: () => void;
  onSetViewMode: (m: ViewModeId) => void;
  onRadius: (r: number) => void;
  onThetaMax: (t: number) => void;
  onHeightScale: (h: number) => void;
  /** デモ走行速度 (m/s) */
  onDriveSpeed: (mps: number) => void;
  onToggleLabels: (on: boolean) => void;
  onCamDist: (d: number) => void;
}

const VIEW_LABEL: Record<ViewModeId, string> = {
  north: "N↑",
  destination: "◎↑",
  heading: "車↑",
};
const VIEW_ORDER: ViewModeId[] = ["north", "destination", "heading"];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export class UI {
  private cb: UICallbacks;
  private searchInput: HTMLInputElement;
  private results: HTMLDivElement;
  private turnBanner: HTMLDivElement;
  private bottomCard: HTMLDivElement;
  private settings: HTMLDivElement;
  private gpsFab: HTMLButtonElement;
  private viewFab: HTMLButtonElement;
  private toastEl: HTMLDivElement;
  private toastTimer = 0;
  private viewMode: ViewModeId = "north";
  private searchTimer = 0;

  constructor(root: HTMLElement, cb: UICallbacks) {
    this.cb = cb;

    // --- 上部 ---
    const topbar = el("div", "topbar");
    const searchbar = el("div", "searchbar");
    searchbar.append(el("span", "icon", "&#128269;"));
    this.searchInput = el("input");
    this.searchInput.placeholder = "行き先を検索";
    this.searchInput.autocomplete = "off";
    searchbar.append(this.searchInput);
    this.results = el("div", "results hidden");
    this.turnBanner = el("div", "turn-banner hidden");
    topbar.append(this.turnBanner, searchbar, this.results);
    root.append(topbar);

    // --- 右下 FAB ---
    const fabs = el("div", "fabs");
    this.viewFab = el("button", "fab", `<small>${VIEW_LABEL.north}</small>`);
    this.viewFab.title = "表示モード切替";
    const recenterFab = el("button", "fab", "&#9678;");
    recenterFab.title = "自車位置へ";
    this.gpsFab = el("button", "fab", "&#9737;");
    this.gpsFab.title = "GPS";
    fabs.append(this.viewFab, recenterFab, this.gpsFab);
    root.append(fabs);

    // --- 下部カード ---
    this.bottomCard = el("div", "bottom-card hidden");
    root.append(this.bottomCard);

    // --- 設定 ---
    this.settings = el("div", "settings collapsed");
    this.settings.innerHTML = `
      <h4><span>コロニー調整</span><span class="toggle">＋</span></h4>
      <div class="settings-body">
        <label>半径 R <span data-v="r">1100 m</span></label>
        <input type="range" data-k="r" min="600" max="6000" step="50" value="1100" />
        <label>曲げの強さ <span data-v="t">66°</span></label>
        <input type="range" data-k="t" min="10" max="100" step="2" value="66" />
        <label>建物高さ <span data-v="h">1.0×</span></label>
        <input type="range" data-k="h" min="0.5" max="3" step="0.25" value="1" />
        <label>走行速度 <span data-v="s">50 km/h</span></label>
        <input type="range" data-k="s" min="5" max="160" step="5" value="50" />
        <label style="cursor:pointer">地名・施設ラベル
          <input type="checkbox" data-k="labels" checked />
        </label>
        <label>カメラ距離 <span data-v="c">16 m</span></label>
        <input type="range" data-k="c" min="5" max="60" step="1" value="16" />
      </div>`;
    root.append(this.settings);

    this.toastEl = el("div", "toast hidden");
    root.append(this.toastEl);

    this.wire(recenterFab);
  }

  private wire(recenterFab: HTMLButtonElement): void {
    this.searchInput.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      const q = this.searchInput.value.trim();
      if (q.length < 2) {
        this.results.classList.add("hidden");
        return;
      }
      this.searchTimer = window.setTimeout(async () => {
        const hits = await this.cb.onSearch(q);
        this.renderResults(hits);
      }, 350);
    });
    this.searchInput.addEventListener("blur", () => {
      setTimeout(() => this.results.classList.add("hidden"), 150);
    });

    this.viewFab.addEventListener("click", () => {
      const i = VIEW_ORDER.indexOf(this.viewMode);
      const next = VIEW_ORDER[(i + 1) % VIEW_ORDER.length];
      this.setViewMode(next);
      this.cb.onSetViewMode(next);
    });
    recenterFab.addEventListener("click", () => this.cb.onRecenter());
    this.gpsFab.addEventListener("click", () => this.cb.onToggleGps());

    const h4 = this.settings.querySelector("h4")!;
    h4.addEventListener("click", () => {
      this.settings.classList.toggle("collapsed");
      h4.querySelector(".toggle")!.textContent =
        this.settings.classList.contains("collapsed") ? "＋" : "−";
    });
    const labelToggle = this.settings.querySelector<HTMLInputElement>(
      'input[data-k="labels"]',
    )!;
    labelToggle.addEventListener("change", () =>
      this.cb.onToggleLabels(labelToggle.checked),
    );

    this.settings.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        const k = inp.dataset.k;
        const label = this.settings.querySelector(`[data-v="${k}"]`)!;
        if (k === "r") {
          label.textContent = `${v} m`;
          this.cb.onRadius(v);
        } else if (k === "t") {
          label.textContent = `${v}°`;
          this.cb.onThetaMax((v * Math.PI) / 180);
        } else if (k === "h") {
          label.textContent = `${v.toFixed(1)}×`;
          this.cb.onHeightScale(v);
        } else if (k === "s") {
          label.textContent = `${v} km/h`;
          this.cb.onDriveSpeed(v / 3.6);
        } else {
          label.textContent = `${v} m`;
          this.cb.onCamDist(v);
        }
      });
    });
  }

  private renderResults(hits: GeocodeHit[]): void {
    this.results.innerHTML = "";
    if (!hits.length) {
      this.results.classList.add("hidden");
      return;
    }
    for (const h of hits) {
      const b = el("button");
      b.textContent = h.label;
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.searchInput.value = h.label.split(",")[0];
        this.results.classList.add("hidden");
        this.cb.onPickDestination(h);
      });
      this.results.append(b);
    }
    this.results.classList.remove("hidden");
  }

  setViewMode(m: ViewModeId): void {
    this.viewMode = m;
    this.viewFab.innerHTML = `<small>${VIEW_LABEL[m]}</small>`;
  }

  setGpsActive(on: boolean): void {
    this.gpsFab.classList.toggle("active", on);
  }

  /** ルート確定: ETA と「案内開始」 */
  showRoutePreview(distText: string, durText: string): void {
    this.bottomCard.className = "bottom-card";
    this.bottomCard.innerHTML = `
      <div class="row"><span class="eta">${durText}</span><span class="sub">${distText}</span></div>
      <div class="actions">
        <button class="btn" data-a="cancel">キャンセル</button>
        <button class="btn primary" data-a="start">案内開始</button>
      </div>`;
    this.bottomCard.querySelector('[data-a="start"]')!
      .addEventListener("click", () => this.cb.onStartNav());
    this.bottomCard.querySelector('[data-a="cancel"]')!
      .addEventListener("click", () => this.cb.onCancelRoute());
  }

  /** ナビ中: 残り情報と「終了」 */
  showNavInfo(distText: string, durText: string): void {
    this.bottomCard.className = "bottom-card";
    this.bottomCard.innerHTML = `
      <div class="row">
        <span class="eta">${durText}</span>
        <span class="sub">残り ${distText}</span>
        <button class="btn" data-a="end" style="flex:0 0 auto;padding:8px 14px">終了</button>
      </div>`;
    this.bottomCard.querySelector('[data-a="end"]')!
      .addEventListener("click", () => this.cb.onEndNav());
  }

  hideBottomCard(): void {
    this.bottomCard.className = "bottom-card hidden";
  }

  setTurn(icon: string, distText: string, road: string): void {
    this.turnBanner.className = "turn-banner";
    // road / distText は OSRM(=OSM) 由来の外部文字列を含むため innerHTML 補間しない
    this.turnBanner.replaceChildren();
    const arrow = el("span", "arrow");
    arrow.textContent = icon;
    const box = el("div");
    const dist = el("div", "dist");
    dist.textContent = distText;
    const rd = el("div", "road");
    rd.textContent = road;
    box.append(dist, rd);
    this.turnBanner.append(arrow, box);
  }

  hideTurn(): void {
    this.turnBanner.className = "turn-banner hidden";
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove("hidden");
    this.toastEl.style.opacity = "1";
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.style.opacity = "0";
      setTimeout(() => this.toastEl.classList.add("hidden"), 300);
    }, 2600);
  }
}

export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}
export function fmtDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} 分`;
  return `${Math.floor(min / 60)} 時間 ${min % 60} 分`;
}
