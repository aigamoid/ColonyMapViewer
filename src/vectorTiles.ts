import * as THREE from "three";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import earcut from "earcut";
import { LocalFrame, tileToLngLat, lngLatToMeters, mercatorScale } from "./geo";
import type { LabelItem } from "./labels";

// OpenFreeMap の planet ベクタータイル (OpenMapTiles スキーマ / APIキー不要)
// 実タイル URL はバージョン付きなので TileJSON から解決する。
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";

export interface RegionMeshes {
  group: THREE.Group;
  /** コロニー変形を適用すべきマテリアル一覧 */
  materials: THREE.Material[];
  /** nearFade を適用するのは建物だけなので識別用に返す */
  buildingMat: THREE.Material;
  /** 道路中心線の点列 [x0,z0,x1,z1,...]。自車を道路上へスナップするのに使う。 */
  roadCenters: Float32Array;
  /** 地名 / 施設ラベル (標高は未設定。呼び出し側で y を入れる) */
  labels: LabelItem[];
}

/**
 * ラベルに採用する POI の class → 優先度。
 * poi レイヤは 1 タイルに 5000 件あり大半が店舗なので、
 * ランドマークになりうる種別だけを拾う。
 */
const POI_PRIORITY: Record<string, number> = {
  attraction: 10,
  monument: 10,
  museum: 11,
  castle: 11,
  railway: 12,
  aerodrome: 12,
  university: 13,
  college: 14,
  town_hall: 14,
  hospital: 15,
  stadium: 15,
  park: 16,
  theatre: 17,
  library: 17,
  cinema: 18,
  place_of_worship: 18,
  golf: 19,
};

/** 交通系 POI は駅級のみ (停留所は数が多すぎる) */
const RAILWAY_SUBCLASS = new Set(["station", "subway", "halt"]);

/** 道路名ラベルを出す道路種別 → 優先度 (小さいほど重要) */
const ROAD_NAME_PRIORITY: Record<string, number> = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
};

/**
 * place の class + rank → 表示階層。
 *
 * 日本では東京都も中央区も class="city" になるため class だけでは階層を分けられない。
 * OMT の rank はタイル内での重要度順で (東京都=1, 各区=12〜15, 町名=16〜)、
 * これを閾値にすると自治体 / 区 / 町名がきれいに分かれる。
 */
function placeKind(cls: string, rank: number): LabelItem["kind"] | null {
  switch (cls) {
    case "city":
    case "town":
      return rank <= 8 ? "city" : "ward";
    case "borough":
    case "suburb":
      return "ward";
    case "village":
    case "quarter":
    case "neighbourhood":
      return "district";
    default:
      return null;
  }
}

type Pt = { x: number; y: number };
type ToLocal = (px: number, py: number) => [number, number];

const EXTENT = 4096; // OpenMapTiles 標準

let tileTemplatePromise: Promise<string> | null = null;
function tileTemplate(): Promise<string> {
  if (!tileTemplatePromise) {
    tileTemplatePromise = fetch(TILEJSON_URL)
      .then((r) => r.json())
      .then((j) => j.tiles[0] as string)
      .catch(() => `${TILEJSON_URL}/{z}/{x}/{y}.pbf`);
  }
  return tileTemplatePromise;
}

async function fetchTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  try {
    const tmpl = await tileTemplate();
    const url = tmpl
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return new VectorTile(new Pbf(buf));
  } catch {
    return null;
  }
}

/**
 * 中心タイル周辺の (2*ring+1)^2 タイルを z で読み込み、
 * 建物(押し出し) / 道路 / 水域 / 地面 のメッシュを frame ローカル座標で構築する。
 */
export async function loadRegion(
  frame: LocalFrame,
  z: number,
  centerTileX: number,
  centerTileY: number,
  ring: number,
  heightScale = 1,
  elevAt: (x: number, z: number) => number = () => 0,
): Promise<RegionMeshes> {
  const group = new THREE.Group();
  group.name = "region";

  const scale = mercatorScale(frame.origin.lat);
  const [originMx, originMy] = lngLatToMeters(frame.origin);

  const seenBuildings = new Set<string>(); // タイル境界での建物重複を除去
  const roadCenters: number[] = [];
  const labels: LabelItem[] = [];
  const seenLabels = new Set<string>(); // タイル境界で同じ地名が重複する

  /**
   * ジオメトリはタイル単位に分けて別々のメッシュにする。
   * 全タイルを 1 個の巨大メッシュにまとめると three の視錐台カリングが
   * まったく効かず、画面外の街まで毎フレーム描画してしまう
   * (東京では建物だけで 880 万頂点になる)。
   */
  interface TileChunk {
    buildingPos: number[];
    buildingBase: number[];
    roadPos: number[];
    roadIdx: number[];
    waterPos: number[];
    waterIdx: number[];
  }
  const chunks: TileChunk[] = [];

  const jobs: Promise<void>[] = [];
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      const tx = centerTileX + dx;
      const ty = centerTileY + dy;
      jobs.push(
        (async () => {
          const tile = await fetchTile(z, tx, ty);
          if (!tile) return;

          const chunk: TileChunk = {
            buildingPos: [],
            buildingBase: [],
            roadPos: [],
            roadIdx: [],
            waterPos: [],
            waterIdx: [],
          };
          const { buildingPos, buildingBase, roadPos, roadIdx, waterPos, waterIdx } =
            chunk;

          const nw = tileToLngLat(tx, ty, z);
          const se = tileToLngLat(tx + 1, ty + 1, z);
          const [nwx, nwy] = lngLatToMeters(nw);
          const [sex, sey] = lngLatToMeters(se);

          const toLocal: ToLocal = (px, py) => {
            const mx = nwx + (px / EXTENT) * (sex - nwx);
            const my = nwy + (py / EXTENT) * (sey - nwy);
            return [(mx - originMx) * scale, (my - originMy) * scale];
          };

          // 自車から遠いタイルは小さな建物を落とす (簡易 LOD)。
          // 住宅地は 1 タイルに数万棟あり、そのまま積むと頂点数が跳ね上がる。
          const ringDist = Math.max(Math.abs(dx), Math.abs(dy));
          const minBuildingArea = ringDist <= 1 ? 24 : 280;

          const bl = tile.layers["building"];
          if (bl) {
            for (let i = 0; i < bl.length; i++) {
              const feat = bl.feature(i);
              const raw = (feat.properties["render_height"] as number) ?? 0;
              // render_height が 0/1 の建物は高さ未登録。控えめにばらつかせる。
              // コロニー変形では高さ = 円柱軸方向なので、過剰に高くすると
              // 建物が軸(観測者付近)へ伸びて視界を塞ぐ。現実的な範囲に収める。
              const known = raw > 2 ? Math.min(raw, 200) : 0;
              const base = known || 8 + ((Number(feat.id) || i) % 5) * 4;
              const h = base * heightScale;
              const minH =
                ((feat.properties["render_min_height"] as number) ?? 0) * heightScale;
              extrudePolygon(
                feat.loadGeometry() as Pt[][],
                toLocal,
                minH,
                h,
                buildingPos,
                buildingBase,
                elevAt,
                seenBuildings,
                minBuildingArea,
              );
            }
          }

          for (const lname of ["water", "ocean"]) {
            const wl = tile.layers[lname];
            if (!wl) continue;
            for (let i = 0; i < wl.length; i++) {
              flatPolygon(
                wl.feature(i).loadGeometry() as Pt[][],
                toLocal,
                0.4,
                waterPos,
                waterIdx,
                elevAt,
              );
            }
          }

          const tl = tile.layers["transportation"];
          if (tl) {
            for (let i = 0; i < tl.length; i++) {
              const feat = tl.feature(i);
              const width = roadWidth(feat.properties["class"] as string);
              if (width <= 0) continue;
              // 車道 (歩道/桟橋を除く) のみスナップ対象にする
              const snappable = width >= 5;
              for (const line of feat.loadGeometry() as Pt[][]) {
                ribbon(line, toLocal, width, 1.2, roadPos, roadIdx, elevAt);
                if (!snappable) continue;
                for (const pt of line) {
                  const [lx, lz] = toLocal(pt.x, pt.y);
                  roadCenters.push(lx, lz);
                }
              }
            }
          }

          collectLabels(tile, toLocal, labels, seenLabels);
          chunks.push(chunk);
        })(),
      );
    }
  }
  await Promise.all(jobs);

  // 注意: ここに「地面プレーン」は置かない。
  // コロニー変形では標高が低い = 円柱軸から遠い なので、地形より下に敷いた平面は
  // 街全体を外側から包む巨大なドームに化けて視界を完全に塞いでしまう。
  // 地面は terrain メッシュが担当する。

  const buildingMat = new THREE.MeshStandardMaterial({
    color: 0xb9c2d0,
    roughness: 0.8,
    flatShading: true,
  });
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xc9ced8,
    roughness: 1,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x3d86a8,
    roughness: 0.3,
    metalness: 0.1,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  // タイルごとに別メッシュ = three が視錐台カリングできる単位になる
  let bVerts = 0;
  let rTris = 0;
  let wTris = 0;
  for (const c of chunks) {
    addMesh(group, "buildings", c.buildingPos, null, buildingMat, c.buildingBase);
    addMesh(group, "roads", c.roadPos, c.roadIdx, roadMat);
    addMesh(group, "water", c.waterPos, c.waterIdx, waterMat);
    bVerts += c.buildingPos.length / 3;
    rTris += c.roadIdx.length / 3;
    wTris += c.waterIdx.length / 3;
  }

  console.info(
    `[region] chunks=${chunks.length} buildingVerts=${bVerts} roadTris=${rTris} waterTris=${wTris} labels=${labels.length}`,
  );

  return {
    group,
    materials: [buildingMat, roadMat, waterMat],
    buildingMat,
    roadCenters: new Float32Array(roadCenters),
    labels,
  };
}

function addMesh(
  group: THREE.Group,
  name: string,
  pos: number[],
  idx: number[] | null,
  mat: THREE.Material,
  baseY?: number[],
): void {
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  if (baseY) g.setAttribute("aBaseY", new THREE.Float32BufferAttribute(baseY, 1));
  if (idx) g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  group.add(m);
}

/** 表示名。UI が日本語なので name:ja があれば優先する。 */
function labelName(props: Record<string, unknown>): string | null {
  const ja = props["name:ja"];
  const base = props["name"];
  const v = (typeof ja === "string" && ja) || (typeof base === "string" && base);
  if (!v) return null;
  // 括弧付きの曖昧さ回避 (例: "中華街 (サンフランシスコ)") は落とす
  return v.replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim() || null;
}

/** place / poi レイヤからラベルを取り出す */
function collectLabels(
  tile: VectorTile,
  toLocal: ToLocal,
  out: LabelItem[],
  seen: Set<string>,
): void {
  const push = (
    geom: Pt[][],
    text: string,
    kind: LabelItem["kind"],
    priority: number,
  ): void => {
    const pt = geom[0]?.[0];
    if (!pt) return;
    const [x, z] = toLocal(pt.x, pt.y);
    // タイル境界をまたぐ重複を除去 (同名・近接)。
    // 道路名は 1 本の道が細切れに入るので、より広い範囲で 1 個に間引く。
    const cell = kind === "road" ? 500 : 50;
    const key = `${text}|${Math.round(x / cell)}|${Math.round(z / cell)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, z, y: 0, text, kind, priority });
  };

  const pl = tile.layers["place"];
  if (pl) {
    for (let i = 0; i < pl.length; i++) {
      const f = pl.feature(i);
      const p = f.properties as Record<string, unknown>;
      const rank = typeof p["rank"] === "number" ? p["rank"] : 40;
      const kind = placeKind(p["class"] as string, rank);
      if (!kind) continue;
      const name = labelName(p);
      if (!name) continue;
      push(f.loadGeometry() as Pt[][], name, kind, rank);
    }
  }

  // 道路名: 走行中どの道にいるかはナビの要
  const tn = tile.layers["transportation_name"];
  if (tn) {
    for (let i = 0; i < tn.length; i++) {
      const f = tn.feature(i);
      const p = f.properties as Record<string, unknown>;
      const prio = ROAD_NAME_PRIORITY[p["class"] as string];
      if (prio === undefined) continue;
      const name = labelName(p);
      if (!name || name.length > 20) continue;

      // 最長の線分の中点に置く (端点だと交差点に重なりやすい)
      let best: Pt[] | null = null;
      let bestLen = 0;
      for (const line of f.loadGeometry() as Pt[][]) {
        if (line.length < 2) continue;
        const len = Math.hypot(
          line[line.length - 1].x - line[0].x,
          line[line.length - 1].y - line[0].y,
        );
        if (len > bestLen) {
          bestLen = len;
          best = line;
        }
      }
      if (!best) continue;
      const mid = best[Math.floor(best.length / 2)];
      push([[mid]], name, "road", 500 + prio);
    }
  }

  const poi = tile.layers["poi"];
  if (poi) {
    for (let i = 0; i < poi.length; i++) {
      const f = poi.feature(i);
      const p = f.properties as Record<string, unknown>;
      const cls = p["class"] as string;
      const base = POI_PRIORITY[cls];
      if (base === undefined) continue;
      if (cls === "railway" && !RAILWAY_SUBCLASS.has(p["subclass"] as string)) continue;
      if (cls === "hospital" && p["subclass"] !== "hospital") continue;
      const name = labelName(p);
      if (!name || name.length > 24) continue;
      const rank = typeof p["rank"] === "number" ? p["rank"] : 9;
      // place より必ず後回しになるよう 1000 番台に置く
      push(f.loadGeometry() as Pt[][], name, "poi", 1000 + base * 100 + rank);
    }
  }
}

function roadWidth(cls: string): number {
  switch (cls) {
    case "motorway":
    case "trunk":
      return 14;
    case "primary":
      return 11;
    case "secondary":
      return 9;
    case "tertiary":
      return 7;
    case "minor":
    case "street":
    case "service":
      return 5;
    default:
      return 0;
  }
}

function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return a / 2;
}

/**
 * MVT の ring 群を exterior/holes に分類する。
 * MVT の巻き方向は実装差があるため、最大面積の ring の符号を exterior 基準とし、
 * 逆符号を穴、同符号を独立ポリゴンとして扱う。
 */
function classifyRings(rings: Pt[][]): { outer: Pt[]; holes: Pt[][] }[] {
  if (rings.length === 1) return [{ outer: rings[0], holes: [] }];
  const areas = rings.map(ringArea);
  let maxAbs = 0;
  let sign = 1;
  for (const a of areas) {
    if (Math.abs(a) > maxAbs) {
      maxAbs = Math.abs(a);
      sign = Math.sign(a) || 1;
    }
  }
  const polys: { outer: Pt[]; holes: Pt[][] }[] = [];
  rings.forEach((ring, i) => {
    if (Math.sign(areas[i]) === sign || areas[i] === 0) {
      polys.push({ outer: ring, holes: [] });
    } else if (polys.length) {
      polys[polys.length - 1].holes.push(ring);
    }
  });
  return polys.length ? polys : [{ outer: rings[0], holes: [] }];
}

function buildFlatRings(
  rings: Pt[][],
  toLocal: ToLocal,
): { flat: number[]; holeIdx: number[]; local: [number, number][]; outerLen: number }[] {
  const out: {
    flat: number[];
    holeIdx: number[];
    local: [number, number][];
    outerLen: number;
  }[] = [];
  for (const { outer, holes } of classifyRings(rings)) {
    const flat: number[] = [];
    const local: [number, number][] = [];
    const holeIdx: number[] = [];
    for (const p of outer) {
      const [lx, lz] = toLocal(p.x, p.y);
      flat.push(lx, lz);
      local.push([lx, lz]);
    }
    for (const h of holes) {
      holeIdx.push(flat.length / 2);
      for (const p of h) {
        const [lx, lz] = toLocal(p.x, p.y);
        flat.push(lx, lz);
        local.push([lx, lz]);
      }
    }
    out.push({ flat, holeIdx, local, outerLen: outer.length });
  }
  return out;
}

type ElevFn = (x: number, z: number) => number;

function flatPolygon(
  rings: Pt[][],
  toLocal: ToLocal,
  y: number,
  outPos: number[],
  outIdx: number[],
  elevAt: ElevFn,
): void {
  for (const { flat, holeIdx } of buildFlatRings(rings, toLocal)) {
    if (flat.length < 6) continue;
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    const base = outPos.length / 3;
    for (let i = 0; i < flat.length; i += 2) {
      outPos.push(flat[i], elevAt(flat[i], flat[i + 1]) + y, flat[i + 1]);
    }
    for (const t of tris) outIdx.push(base + t);
  }
}

function extrudePolygon(
  rings: Pt[][],
  toLocal: ToLocal,
  minH: number,
  maxH: number,
  outPos: number[],
  outBase: number[],
  elevAt: ElevFn,
  seen: Set<string>,
  minArea: number,
): void {
  for (const { flat, holeIdx, local, outerLen } of buildFlatRings(rings, toLocal)) {
    if (local.length < 3) continue;
    // フットプリント面積でフィルタ (微小ノイズ / 巻き方向誤判定による巨大ポリゴンを除外)
    let area2 = 0;
    for (let i = 0, j = outerLen - 1; i < outerLen; j = i++) {
      area2 += local[j][0] * local[i][1] - local[i][0] * local[j][1];
    }
    const area = Math.abs(area2) / 2;
    if (area < minArea || area > 9000) continue;
    // 外周が大きく広がるポリゴン (巻き方向誤判定 / 巨大複合体) を除外
    let minLx = Infinity;
    let maxLx = -Infinity;
    let minLz = Infinity;
    let maxLz = -Infinity;
    for (let i = 0; i < outerLen; i++) {
      const [lx, lz] = local[i];
      if (lx < minLx) minLx = lx;
      if (lx > maxLx) maxLx = lx;
      if (lz < minLz) minLz = lz;
      if (lz > maxLz) maxLz = lz;
    }
    if (maxLx - minLx > 220 || maxLz - minLz > 220) continue;
    // 建物は centroid の標高に据える (床を水平に保つ)
    let cx = 0;
    let cz = 0;
    for (const [lx, lz] of local) {
      cx += lx;
      cz += lz;
    }
    cx /= local.length;
    cz /= local.length;
    const key = `${Math.round(cx / 3)}:${Math.round(cz / 3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = elevAt(cx, cz);
    // 単調にならないよう位置ハッシュで軽くばらつかせる (±25% 程度)。
    const rnd = Math.abs(Math.sin(cx * 12.9898 + cz * 78.233)) % 1;
    const varied = maxH * (0.85 + rnd * 0.35);
    // 高層ビルの圧縮。コロニー内面では建物の「上」が観測者を向くため、
    // 200m 級の塔をそのまま立てると 1 棟で画面の 4 割を埋めて地図が読めなくなる。
    // 低層はそのまま、高層ほど強く圧縮する (カーナビの模式的な 3D 建物と同じ考え方)。
    const compressed = Math.min(varied, 30 + varied * 0.25);
    const botY = e + minH;
    const topY = e + Math.min(compressed, 110);
    const vertsBefore = outPos.length / 3;
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    for (let i = 0; i < tris.length; i += 3) {
      const a = local[tris[i]];
      const b = local[tris[i + 1]];
      const c = local[tris[i + 2]];
      outPos.push(a[0], topY, a[1], c[0], topY, c[1], b[0], topY, b[1]);
    }
    for (let i = 0; i < outerLen; i++) {
      const [x1, z1] = local[i];
      const [x2, z2] = local[(i + 1) % outerLen];
      outPos.push(
        x1, botY, z1, x2, botY, z2, x2, topY, z2,
        x1, botY, z1, x2, topY, z2, x1, topY, z1,
      );
    }
    // この建物が生成した全頂点に接地高さを持たせる
    const added = outPos.length / 3 - vertsBefore;
    for (let i = 0; i < added; i++) outBase.push(botY);
  }
}

function ribbon(
  line: Pt[],
  toLocal: ToLocal,
  width: number,
  y: number,
  outPos: number[],
  outIdx: number[],
  elevAt: ElevFn,
): void {
  const hw = width / 2;
  const pts = line.map((p) => toLocal(p.x, p.y));
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * hw;
    const nz = (dx / len) * hw;
    const e1 = elevAt(x1, z1) + y;
    const e2 = elevAt(x2, z2) + y;
    const base = outPos.length / 3;
    outPos.push(
      x1 + nx, e1, z1 + nz,
      x1 - nx, e1, z1 - nz,
      x2 + nx, e2, z2 + nz,
      x2 - nx, e2, z2 - nz,
    );
    // 上向き (+y) を表とする巻き順
    outIdx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
}
