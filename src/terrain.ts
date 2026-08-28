import * as THREE from "three";
import { LocalFrame, tileToLngLat } from "./geo";

// AWS Open Data "Terrain Tiles" (Terrarium PNG エンコード / APIキー不要)
const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

export interface TerrainResult {
  mesh: THREE.Mesh | null;
  material: THREE.Material | null;
  /** ローカル(x,z)メートル -> 標高(m)。データが無い場合は常に 0 を返す。 */
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
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
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
    return out;
  } catch {
    return null;
  }
}

/**
 * 中心タイル周辺の地形を読み込み、標高で変位させたグリッドメッシュを返す。
 * 取得に失敗したら mesh=null, sample()=0 のフラット地形。
 */
export async function loadTerrain(
  frame: LocalFrame,
  z: number,
  centerTileX: number,
  centerTileY: number,
  ring: number,
): Promise<TerrainResult> {
  const flat: TerrainResult = { mesh: null, material: null, sample: () => 0 };

  const tilePx = 256;
  const span = 2 * ring + 1;
  const grid = new Float32Array(span * tilePx * (span * tilePx));
  const gridW = span * tilePx;
  let got = 0;

  const jobs: Promise<void>[] = [];
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      jobs.push(
        (async () => {
          const t = await fetchHeightTile(z, centerTileX + dx, centerTileY + dy);
          if (!t) return;
          got++;
          const ox = (dx + ring) * tilePx;
          const oy = (dy + ring) * tilePx;
          for (let py = 0; py < tilePx; py++) {
            for (let px = 0; px < tilePx; px++) {
              grid[(oy + py) * gridW + (ox + px)] = t[py * tilePx + px];
            }
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  if (got === 0) return flat;

  // グリッド境界のローカル座標
  const nw = frame.toLocal(tileToLngLat(centerTileX - ring, centerTileY - ring, z));
  const se = frame.toLocal(
    tileToLngLat(centerTileX + ring + 1, centerTileY + ring + 1, z),
  );
  const minX = Math.min(nw.x, se.x);
  const maxX = Math.max(nw.x, se.x);
  const minZ = Math.min(nw.z, se.z);
  const maxZ = Math.max(nw.z, se.z);

  const sample = (x: number, zc: number): number => {
    const u = (x - minX) / (maxX - minX);
    const v = (zc - minZ) / (maxZ - minZ);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const gx = Math.min(gridW - 1, Math.max(0, u * (gridW - 1)));
    const gy = Math.min(gridW - 1, Math.max(0, v * (gridW - 1)));
    return grid[Math.round(gy) * gridW + Math.round(gx)];
  };

  // 表示用メッシュ (間引き)
  const seg = 220;
  const geo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx;
    const zc = pos.getZ(i) + cz;
    pos.setY(i, sample(x, zc));
  }
  geo.translate(cx, 0, cz);
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x3f5142,
    roughness: 1,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "terrain";
  return { mesh, material, sample };
}
