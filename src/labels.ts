import * as THREE from "three";
import { ColonyUniforms, colonyWarpCPU } from "./colony";

/**
 * 地名 / 施設ラベル。
 *
 * 3D 空間にスプライトを置くのではなく DOM オーバーレイで描く:
 * - どの DPI でも文字が鮮明 (地図ラベルは可読性が最優先)
 * - 縁取り・字間などを CSS でそのまま表現できる
 * - 重なり除去 (デクラッタ) をスクリーン座標で素直に書ける
 *
 * 位置はコロニー変形後のビュー空間を CPU で計算して投影する
 * (自車が動くたび変形が変わるので毎フレーム再計算)。
 */

export type LabelKind = "city" | "district" | "poi";

export interface LabelItem {
  /** ローカル座標 (m) */
  x: number;
  z: number;
  /** 標高 + 浮かせる量 */
  y: number;
  text: string;
  kind: LabelKind;
  /** 小さいほど重要。デクラッタの優先度 */
  priority: number;
}

interface Slot {
  el: HTMLDivElement;
  used: boolean;
}

const KIND_STYLE: Record<LabelKind, { size: number; weight: number; color: string }> = {
  city: { size: 19, weight: 700, color: "#ffffff" },
  district: { size: 14, weight: 600, color: "#dfe8f5" },
  poi: { size: 12, weight: 500, color: "#c9d6e8" },
};

/** ラベルを表示する最大距離 (m)。種別ごと。 */
const MAX_DIST: Record<LabelKind, number> = {
  city: 9000,
  district: 4000,
  poi: 900,
};

export class LabelLayer {
  private root: HTMLDivElement;
  private slots: Slot[] = [];
  private items: LabelItem[] = [];
  private visible = true;
  private readonly ndc = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "labels";
    container.append(this.root);
  }

  setItems(items: LabelItem[]): void {
    this.items = items;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? "" : "none";
  }

  get enabled(): boolean {
    return this.visible;
  }

  clear(): void {
    this.items = [];
    for (const s of this.slots) s.el.style.display = "none";
  }

  private slot(i: number): Slot {
    let s = this.slots[i];
    if (!s) {
      const el = document.createElement("div");
      el.className = "label";
      this.root.append(el);
      s = { el, used: false };
      this.slots[i] = s;
    }
    return s;
  }

  /** 毎フレーム: 変形 → 投影 → 重なり除去 → DOM 更新 */
  update(camera: THREE.PerspectiveCamera, colony: ColonyUniforms): void {
    if (!this.visible || !this.items.length) return;

    const W = innerWidth;
    const H = innerHeight;
    const carX = colony.uCarLocal.value.x;
    const carZ = colony.uCarLocal.value.y;

    type Cand = {
      item: LabelItem;
      sx: number;
      sy: number;
      w: number;
      h: number;
      dist: number;
      alpha: number;
    };
    const cands: Cand[] = [];

    for (const it of this.items) {
      const dist = Math.hypot(it.x - carX, it.z - carZ);
      const maxD = MAX_DIST[it.kind];
      if (dist > maxD) continue;

      const p = colonyWarpCPU(it.x, it.y, it.z, colony);
      this.ndc.copy(p).project(camera);
      if (this.ndc.z < -1 || this.ndc.z > 1) continue;

      const sx = (this.ndc.x * 0.5 + 0.5) * W;
      const sy = (-this.ndc.y * 0.5 + 0.5) * H;
      if (sx < -80 || sx > W + 80 || sy < -30 || sy > H + 30) continue;

      const st = KIND_STYLE[it.kind];
      // 実測せず概算 (毎フレームの reflow を避ける)
      const w = it.text.length * st.size * 0.62 + 12;
      const h = st.size * 1.5;
      // 遠いほど薄く
      const alpha = 1 - Math.min(1, Math.max(0, (dist / maxD - 0.65) / 0.35)) * 0.75;
      cands.push({ item: it, sx, sy, w, h, dist, alpha });
    }

    // 重要度 → 近い順
    cands.sort(
      (a, b) => a.item.priority - b.item.priority || a.dist - b.dist,
    );

    const placed: Cand[] = [];
    const limit = 70;
    for (const c of cands) {
      if (placed.length >= limit) break;
      const l = c.sx - c.w / 2;
      const r = c.sx + c.w / 2;
      const t = c.sy - c.h / 2;
      const b = c.sy + c.h / 2;
      let hit = false;
      for (const q of placed) {
        if (
          l < q.sx + q.w / 2 &&
          r > q.sx - q.w / 2 &&
          t < q.sy + q.h / 2 &&
          b > q.sy - q.h / 2
        ) {
          hit = true;
          break;
        }
      }
      if (!hit) placed.push(c);
    }

    for (let i = 0; i < placed.length; i++) {
      const c = placed[i];
      const s = this.slot(i);
      const st = KIND_STYLE[c.item.kind];
      const el = s.el;
      if (el.textContent !== c.item.text) el.textContent = c.item.text;
      el.style.display = "";
      el.style.transform = `translate(-50%,-50%) translate(${c.sx.toFixed(1)}px,${c.sy.toFixed(1)}px)`;
      el.style.fontSize = `${st.size}px`;
      el.style.fontWeight = String(st.weight);
      el.style.color = st.color;
      el.style.opacity = c.alpha.toFixed(2);
    }
    for (let i = placed.length; i < this.slots.length; i++) {
      this.slots[i].el.style.display = "none";
    }
  }
}
