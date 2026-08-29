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

/** 市区町村 > 区 > 町名 > 施設 の 4 階層。色とサイズで階層を区別する。 */
export type LabelKind = "city" | "ward" | "district" | "road" | "poi";

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

interface KindStyle {
  /** この距離まではフルサイズ・不透明 */
  near: number;
  /** これを超えたら表示しない */
  far: number;
  sizeNear: number;
  sizeFar: number;
  alphaFar: number;
  /** 同時に出す最大数 */
  maxCount: number;
}

/**
 * コロニー変形では遠景が地平線付近に強く圧縮される。
 * そこを小さい文字で埋めると読めないので、遠いラベルは「薄く・少し大きく」して
 * 背景として奥行きを示し、近いラベルは濃く小さめにして主役にする。
 */
const KIND: Record<LabelKind, KindStyle> = {
  city: { near: 4000, far: 26000, sizeNear: 20, sizeFar: 28, alphaFar: 0.38, maxCount: 6 },
  ward: { near: 1500, far: 12000, sizeNear: 17, sizeFar: 23, alphaFar: 0.34, maxCount: 10 },
  district: { near: 450, far: 2400, sizeNear: 13.5, sizeFar: 17, alphaFar: 0.32, maxCount: 24 },
  // 走行中の道路名はナビの要。手前を濃く、少し先まで見せる
  road: { near: 250, far: 900, sizeNear: 13, sizeFar: 13, alphaFar: 0.3, maxCount: 10 },
  // 建物 / 施設は遠くにあっても役に立たないので早めに打ち切る
  poi: { near: 160, far: 430, sizeNear: 13, sizeFar: 11.5, alphaFar: 0.35, maxCount: 14 },
};

export class LabelLayer {
  private root: HTMLDivElement;
  private els: HTMLDivElement[] = [];
  private items: LabelItem[] = [];
  private visible = true;
  private readonly v = new THREE.Vector3();

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

  clear(): void {
    this.items = [];
    for (const el of this.els) el.style.display = "none";
  }

  private el(i: number): HTMLDivElement {
    let el = this.els[i];
    if (!el) {
      el = document.createElement("div");
      this.root.append(el);
      this.els[i] = el;
    }
    return el;
  }

  /** 毎フレーム: 変形 → 投影 → 重なり除去 → DOM 更新 */
  update(camera: THREE.PerspectiveCamera, colony: ColonyUniforms): void {
    if (!this.visible || !this.items.length) return;

    const W = innerWidth;
    const H = innerHeight;
    const carX = colony.uCarLocal.value.x;
    const carZ = colony.uCarLocal.value.y;

    interface Cand {
      item: LabelItem;
      sx: number;
      sy: number;
      w: number;
      h: number;
      size: number;
      alpha: number;
      dist: number;
    }
    const cands: Cand[] = [];

    for (const it of this.items) {
      const st = KIND[it.kind];
      const dist = Math.hypot(it.x - carX, it.z - carZ);
      if (dist > st.far) continue;

      colonyWarpCPU(it.x, it.y, it.z, colony, this.v);
      this.v.project(camera);
      if (this.v.z < -1 || this.v.z > 1) continue;

      const sx = (this.v.x * 0.5 + 0.5) * W;
      const sy = (-this.v.y * 0.5 + 0.5) * H;
      if (sx < -100 || sx > W + 100 || sy < -40 || sy > H + 40) continue;

      // near..far を 0..1 に。near 以内は完全にフルサイズ・不透明。
      const t = THREE.MathUtils.clamp(
        (dist - st.near) / Math.max(1, st.far - st.near),
        0,
        1,
      );
      // 距離感が出るよう非線形に (手前でほとんど変化させない)
      const k = t * t;
      const size = st.sizeNear + (st.sizeFar - st.sizeNear) * k;
      const alpha = 1 + (st.alphaFar - 1) * k;

      cands.push({
        item: it,
        sx,
        sy,
        w: it.text.length * size * 0.64 + 14,
        h: size * 1.6,
        size,
        alpha,
        dist,
      });
    }

    cands.sort((a, b) => a.item.priority - b.item.priority || a.dist - b.dist);

    const placed: Cand[] = [];
    const perKind: Record<string, number> = {};
    for (const c of cands) {
      if (placed.length >= 64) break;
      const st = KIND[c.item.kind];
      const used = perKind[c.item.kind] ?? 0;
      if (used >= st.maxCount) continue;

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
      if (hit) continue;
      placed.push(c);
      perKind[c.item.kind] = used + 1;
    }

    for (let i = 0; i < placed.length; i++) {
      const c = placed[i];
      const el = this.el(i);
      const cls = `label label--${c.item.kind}`;
      if (el.className !== cls) el.className = cls;
      if (el.textContent !== c.item.text) el.textContent = c.item.text;
      el.style.display = "";
      el.style.transform = `translate(-50%,-50%) translate(${c.sx.toFixed(1)}px,${c.sy.toFixed(1)}px)`;
      el.style.fontSize = `${c.size.toFixed(1)}px`;
      el.style.opacity = c.alpha.toFixed(2);
    }
    for (let i = placed.length; i < this.els.length; i++) {
      this.els[i].style.display = "none";
    }
  }
}
