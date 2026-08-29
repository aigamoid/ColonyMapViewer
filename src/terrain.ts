import * as THREE from "three";
import { LocalFrame, tileToLngLat } from "./geo";

// AWS Open Data "Terrain Tiles" (Terrarium PNG エンコード / APIキー不要)
const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE_PX = 256;

export interface TerrainResult {
  mesh: THREE.Mesh | null;
  material: THREE.Material | null;
  /**
   * ローカル(x,z)メートル -> 標高(m)。
   * 描画メッシュの三角形と**完全に一致**する値を返す (道路や建物を地面に正しく載せるため)。
   * データが無い場合は常に 0。
   */
  sample: (x: number, z: number) => number;
}

function decodeElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

async function fetchHeightTile(
  z: number,
  x: number,
  y: number,
): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${TERRAIN_URL}/${z}/${x}/${y}.png`, { mode: "cors" });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const out = new Float32Array(bmp.width * bmp.height);
    for (let i = 0; i < out.length; i++) {
      out[i] = decodeElevation(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    bmp.close();
    return out;
  } catch {
    return null;
  }
}

/**
 * 中心タイル周辺の地形を読み込み、標高で変位させたグリッドメッシュを返す。
 *
 * 重要: 表示メッシュの頂点高さと sample() は同じ配列 (mesh grid) を参照し、
 * sample() は three の PlaneGeometry 相当の三角形分割を再現して補間する。
 * これにより「道路が地形に埋まる / 浮く」問題が起きない。
 */
export async function loadTerrain(
  frame: LocalFrame,
  z: number,
  centerTileX: number,
  centerTileY: number,
  ring: number,
  seg = 512,
): Promise<TerrainResult> {
  const flat: TerrainResult = { mesh: null, material: null, sample: () => 0 };

  const span = 2 * ring + 1;
  const fineW = span * TILE_PX;
  const fine = new Float32Array(fineW * fineW);
  let got = 0;

  await Promise.all(
    Array.from({ length: span * span }, (_, k) => {
      const dx = (k % span) - ring;
      const dy = Math.floor(k / span) - ring;
      return (async () => {
        const t = await fetchHeightTile(z, centerTileX + dx, centerTileY + dy);
        if (!t) return;
        got++;
        // タイル行 0 = 北。dy が増える = 南へ。fine の行 0 も北。
        const ox = (dx + ring) * TILE_PX;
        const oy = (dy + ring) * TILE_PX;
        for (let py = 0; py < TILE_PX; py++) {
          fine.set(
            t.subarray(py * TILE_PX, (py + 1) * TILE_PX),
            (oy + py) * fineW + ox,
          );
        }
      })();
    }),
  );
  if (got === 0) return flat;

  // 範囲: NW タイル角 と SE タイル角。z(北)は NW のほうが大きい。
  const nw = frame.toLocal(tileToLngLat(centerTileX - ring, centerTileY - ring, z));
  const se = frame.toLocal(
    tileToLngLat(centerTileX + ring + 1, centerTileY + ring + 1, z),
  );
  const westX = Math.min(nw.x, se.x);
  const eastX = Math.max(nw.x, se.x);
  const northZ = Math.max(nw.z, se.z);
  const southZ = Math.min(nw.z, se.z);
  const width = eastX - westX;
  const depth = northZ - southZ;

  /** 高解像度グリッドをバイリニア読み。u:0=西→1=東, v:0=北→1=南 */
  const readFine = (u: number, v: number): number => {
    const fx = Math.min(fineW - 1, Math.max(0, u * (fineW - 1)));
    const fy = Math.min(fineW - 1, Math.max(0, v * (fineW - 1)));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(fineW - 1, x0 + 1);
    const y1 = Math.min(fineW - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = fine[y0 * fineW + x0];
    const h10 = fine[y0 * fineW + x1];
    const h01 = fine[y1 * fineW + x0];
    const h11 = fine[y1 * fineW + x1];
    return (
      h00 * (1 - tx) * (1 - ty) +
      h10 * tx * (1 - ty) +
      h01 * (1 - tx) * ty +
      h11 * tx * ty
    );
  };

  // --- メッシュ格子 (これが「地面の正典」) ---
  const N = seg + 1; // 1辺の頂点数
  const h = new Float32Array(N * N); // 行 0 = 北
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      h[iy * N + ix] = readFine(ix / seg, iy / seg);
    }
  }

  const cellX = width / seg;
  const cellZ = depth / seg;
  const vx = (ix: number) => westX + ix * cellX;
  const vz = (iy: number) => northZ - iy * cellZ;

  const positions = new Float32Array(N * N * 3);
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const i = (iy * N + ix) * 3;
      positions[i] = vx(ix);
      positions[i + 1] = h[iy * N + ix];
      positions[i + 2] = vz(iy);
    }
  }

  // 三角形分割: 各セルを対角 b-d (=(ix,iy+1)-(ix+1,iy)) で 2 分割。
  // 巻き順は上向き法線 (+y) になる (a,d,b) / (b,d,c)。
  const indices = new Uint32Array(seg * seg * 6);
  let p = 0;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iy * N + ix;
      const b = (iy + 1) * N + ix;
      const c = (iy + 1) * N + ix + 1;
      const d = iy * N + ix + 1;
      indices[p++] = a;
      indices[p++] = d;
      indices[p++] = b;
      indices[p++] = b;
      indices[p++] = d;
      indices[p++] = c;
    }
  }

  /** 描画三角形と一致する標高 */
  const sample = (x: number, zc: number): number => {
    const gx = ((x - westX) / width) * seg;
    const gy = ((northZ - zc) / depth) * seg;
    if (gx < 0 || gx > seg || gy < 0 || gy > seg) return 0;
    const ix = Math.min(seg - 1, Math.floor(gx));
    const iy = Math.min(seg - 1, Math.floor(gy));
    const fx = gx - ix;
    const fy = gy - iy;
    const ha = h[iy * N + ix];
    const hb = h[(iy + 1) * N + ix];
    const hc = h[(iy + 1) * N + ix + 1];
    const hd = h[iy * N + ix + 1];
    return fx + fy <= 1
      ? ha + fx * (hd - ha) + fy * (hb - ha)
      : hc + (1 - fx) * (hb - hc) + (1 - fy) * (hd - hc);
  };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x46533f,
    roughness: 1,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "terrain";
  return { mesh, material, sample };
}
