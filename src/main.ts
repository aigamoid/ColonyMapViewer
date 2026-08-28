import * as THREE from "three";
import { LocalFrame, LngLat, lngLatToTile } from "./geo";
import {
  ColonyUniforms,
  createColonyUniforms,
  setForward,
  applyColony,
  colonyThetaInverse,
} from "./colony";
import { loadRegion } from "./vectorTiles";
import { loadTerrain } from "./terrain";
import { Car } from "./car";
import {
  geocode,
  route as osrmRoute,
  Route,
  maneuverIcon,
  describeManeuver,
} from "./routing";
import { UI, ViewModeId, fmtDistance, fmtDuration } from "./ui";
import type { GeocodeHit } from "./routing";
import { LabelLayer } from "./labels";

// 初期位置: 東京駅 (丸の内側。皇居・銀座・日本橋が周囲に広がる)
const START: LngLat = { lng: 139.7671, lat: 35.6812 };
const START_HEADING = (-90 * Math.PI) / 180; // 西向き = 丸の内から皇居方向を見る
const TILE_Z = 14; // OpenFreeMap planet の最大ズーム
const TILE_RING = 2;
const TERRAIN_Z = 13;
const TERRAIN_RING = 1; // ベクタータイル範囲 (約9.7km) に合わせる
const BUILDING_EXAGGERATION = 1.0;
/**
 * コロニー半径。建物の高さは円柱軸方向に伸びるため、
 * R は想定する最大建物高さ (約 220m) より十分大きくないと建物が観測者を串刺しにする。
 */
const DEFAULT_R = 1100;
/** 巻き上げ角の上限 (rad)。約66°。90°を超えると遠景が屋根の壁に潰れる。 */
const DEFAULT_THETA_MAX = 1.15;
/** カメラの基本仰角 (rad)。上向きにするほどコロニー壁が広く映る。 */
const BASE_PITCH = 0.2;

const app = document.getElementById("app")!;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x0b0e14);
app.append(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b0e14, 3000, 24000);
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.5, 60000);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2a33, 1.4));
const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
sun.position.set(-400, 800, 300);
scene.add(sun);

// 星空背景
{
  const g = new THREE.BufferGeometry();
  const n = 1500;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(14000);
    p.set([v.x, Math.abs(v.y) + 400, v.z], i * 3);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899bb, size: 8 })));
}

const colony: ColonyUniforms = createColonyUniforms(DEFAULT_R, DEFAULT_THETA_MAX);
// frame は GPS で遠方へ飛んだときに貼り直す (世界の原点を自車位置へ再アンカー)
let frame = new LocalFrame(START);
const car = new Car(frame);

// 自車メッシュ
const carMesh = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2, 0.9, 4.4),
    new THREE.MeshStandardMaterial({ color: 0xe8433f, roughness: 0.4, metalness: 0.3 }),
  );
  body.position.y = 0.75;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.8, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.2, metalness: 0.5 }),
  );
  cabin.position.set(0, 1.45, -0.2);
  carMesh.add(body, cabin);
}
scene.add(carMesh);

// 状態
let regionGroup: THREE.Group | null = null;
let terrainMesh: THREE.Mesh | null = null;
let gridMesh: THREE.Object3D | null = null;
let heightScale = BUILDING_EXAGGERATION;
let elevSample: (x: number, z: number) => number = () => 0;
let worldEpoch = 0; // 読み込み中に再配置が走ったら古い結果を捨てるための世代番号
let lastLabelItems: import("./labels").LabelItem[] = []; // デバッグ用
let viewMode: ViewModeId = "north";
let camDist = 16;
let dragYaw = 0;
let dragPitch = 0;

let destPin: THREE.Object3D | null = null;
let destLngLat: LngLat | null = null;
let routeLine: THREE.Object3D | null = null;
let currentRoute: Route | null = null;
let routeLocal: { x: number; z: number }[] = [];
let stepIdx = 0;
let navigating = false;

/** コロニー曲面を可視化する参照グリッド (200m 間隔・控えめ) */
function addColonyGrid(): void {
  const ext = 1600;
  const step = 200;
  const pos: number[] = [];
  const push = (x: number, z: number) => pos.push(x, elevSample(x, z) + 0.6, z);
  for (let g = -ext; g <= ext; g += step) {
    for (let s = -ext; s < ext; s += 20) {
      push(g, s);
      push(g, s + 20);
      push(s, g);
      push(s + 20, g);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x2ea3ff,
    transparent: true,
    opacity: 0.05,
  });
  applyColony(mat, colony);
  scene.add(new THREE.LineSegments(geo, mat));
}

/** 目的地ピン: ローカル絶対座標でジオメトリを組み、コロニー変形を適用して曲面に沿わせる */
function makePin(dx: number, dz: number): THREE.Object3D {
  const e = elevSample(dx, dz);
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2ea3ff,
    emissive: 0x1f6feb,
    emissiveIntensity: 0.7,
    roughness: 0.4,
  });
  applyColony(mat, colony);
  const stemGeo = new THREE.CylinderGeometry(1.2, 1.2, 22, 8);
  stemGeo.translate(dx, e + 11, dz);
  const headGeo = new THREE.SphereGeometry(6, 16, 16);
  headGeo.translate(dx, e + 26, dz);
  grp.add(new THREE.Mesh(stemGeo, mat), new THREE.Mesh(headGeo, mat));
  grp.name = "destPin";
  return grp;
}

/**
 * 「目的地アップ」で進行方向から離れてよい最大角。
 * 真に目的地を正面に据えると、目的地が真横〜後方にあるとき
 * 走っている道が視界から外れてナビとして使えないため上限を設ける。
 */
const DEST_UP_MAX_DEV = (58 * Math.PI) / 180;

/** 現在の巻き付け方位 (rad, 北=0)。目標へ滑らかに追従させて画面の飛びを防ぐ。 */
let forwardAngle = 0;

/** a を b との差が ±π に収まるよう正規化 */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function targetForwardAngle(): number {
  if (viewMode === "north") return 0;

  const heading = wrapAngle(car.heading);
  if (viewMode === "heading" || !destLngLat) return heading;

  // 目的地アップ: 進行方向を基準に、目的地方位へ最大 DEST_UP_MAX_DEV まで寄せる
  const d = frame.toLocal(destLngLat);
  const dx = d.x - car.x;
  const dz = d.z - car.z;
  if (Math.hypot(dx, dz) < 1) return heading;
  const bearing = Math.atan2(dx, dz);
  const dev = wrapAngle(bearing - heading);
  return heading + THREE.MathUtils.clamp(dev, -DEST_UP_MAX_DEV, DEST_UP_MAX_DEV);
}

function updateForward(dt: number): void {
  const target = targetForwardAngle();
  // 最短回りで補間
  const delta = wrapAngle(target - forwardAngle);
  forwardAngle = wrapAngle(forwardAngle + delta * Math.min(1, dt * 4));
  setForward(colony, Math.sin(forwardAngle), Math.cos(forwardAngle));
}

/** 表示モードを切り替える。ドラッグで回した視点は基準に戻す。 */
function setViewMode(m: ViewModeId): void {
  viewMode = m;
  // これを残すとカメラだけ横を向いたままになり「北を向いていない」ように見える
  dragYaw = 0;
  dragPitch = 0;
  ui.setViewMode(m);
}

// カメラ操作 & 地図クリック
{
  let dragging = false;
  let lx = 0;
  let ly = 0;
  let downX = 0;
  let downY = 0;
  // ジェスチャがキャンバス上で始まったかどうか。
  // これを見ないと、UI ボタンを押した pointerup まで地図クリックとして拾ってしまい
  // 「終了」を押した直後に目的地が再設定されてナビが終わらない。
  let downOnCanvas = false;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = true;
    downOnCanvas = true;
    lx = downX = e.clientX;
    ly = downY = e.clientY;
  });
  addEventListener("pointerup", (e) => {
    dragging = false;
    if (!downOnCanvas) return;
    downOnCanvas = false;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 5) {
      pickDestinationFromScreen(e.clientX, e.clientY);
    }
  });
  addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dragYaw -= (e.clientX - lx) * 0.005;
    dragPitch = THREE.MathUtils.clamp(dragPitch + (e.clientY - ly) * 0.004, -0.5, 0.9);
    lx = e.clientX;
    ly = e.clientY;
  });
}

const raycaster = new THREE.Raycaster();
function pickDestinationFromScreen(sx: number, sy: number): void {
  if (!regionGroup) return;
  raycaster.setFromCamera(
    new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1),
    camera,
  );
  const hits = raycaster.intersectObjects(regionGroup.children, true);
  if (!hits.length) return;
  const local = inverseColony(hits[0].point);
  setDestination(frame.toLngLat(local.x, local.z), "地図で指定した地点");
}

/** ビュー空間座標 -> ローカル(x,z) 近似逆変換 */
function inverseColony(p: THREE.Vector3): { x: number; z: number } {
  const f = colony.uForward.value;
  const a = colony.uAxis.value;
  const R = colony.uColonyR.value;
  const relFwd = p.x * f.x + p.z * f.y;
  const relLat = p.x * a.x + p.z * a.y;
  const theta = Math.atan2(relFwd, R - p.y);
  const s = colonyThetaInverse(theta, colony);
  return {
    x: car.x + f.x * s + a.x * relLat,
    z: car.z + f.y * s + a.y * relLat,
  };
}

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function clearWorld(): void {
  labels.clear();
  for (const o of [regionGroup, terrainMesh, gridMesh]) {
    if (!o) continue;
    scene.remove(o);
    disposeTree(o);
  }
  regionGroup = null;
  terrainMesh = null;
  gridMesh = null;
  elevSample = () => 0;
  car.setElevationSampler(elevSample);
}

/**
 * origin を中心に地形・ベクタータイルを読み込む。
 * 既存の世界は破棄され、frame と自車位置が origin 基準に貼り直される。
 */
async function loadWorld(origin: LngLat, placeCarAt?: LngLat): Promise<void> {
  const epoch = ++worldEpoch;
  clearWorld();
  frame = new LocalFrame(origin);
  car.setFrame(frame, placeCarAt);
  ui.toast("地図データを読み込み中…");

  const [ttxf, ttyf] = lngLatToTile(origin.lng, origin.lat, TERRAIN_Z);
  const terrain = await loadTerrain(
    frame,
    TERRAIN_Z,
    Math.floor(ttxf),
    Math.floor(ttyf),
    TERRAIN_RING,
  );
  if (epoch !== worldEpoch) return;

  car.setElevationSampler(terrain.sample);
  elevSample = terrain.sample;
  if (terrain.mesh && terrain.material) {
    applyColony(terrain.material, colony);
    terrainMesh = terrain.mesh;
    scene.add(terrain.mesh);
  }
  addColonyGrid();

  const [txf, tyf] = lngLatToTile(origin.lng, origin.lat, TILE_Z);
  const region = await loadRegion(
    frame,
    TILE_Z,
    Math.floor(txf),
    Math.floor(tyf),
    TILE_RING,
    heightScale,
    terrain.sample,
  );
  if (epoch !== worldEpoch) {
    disposeTree(region.group);
    return;
  }
  for (const m of region.materials) {
    const isBuilding = m === region.buildingMat;
    applyColony(m, colony, { nearFade: isBuilding, heightFalloff: isBuilding });
  }
  regionGroup = region.group;
  scene.add(region.group);
  snapCarToRoad(region.roadCenters);

  // ラベルは地面から少し浮かせる (建物や地形に埋もれないように)
  for (const l of region.labels) {
    // 階層が上ほど高く浮かせて、建物越しでも読めるようにする
    const lift =
      l.kind === "poi" ? 20 : l.kind === "district" ? 60 : l.kind === "ward" ? 110 : 170;
    l.y = elevSample(l.x, l.z) + lift;
  }
  labels.setItems(region.labels);
  lastLabelItems = region.labels;
  ui.toast(terrain.mesh ? "準備完了" : "準備完了 (地形データなし)");
}

/**
 * 自車を最寄りの車道へ寄せる。
 * 建物の内部で開始すると TPS カメラが壁に埋まって何も見えないため。
 * GPS 追従中は実測位置を優先するのでスナップしない。
 */
function snapCarToRoad(centers: Float32Array): void {
  if (car.mode === "gps" || centers.length < 2) return;
  let bestD = Infinity;
  let bx = car.x;
  let bz = car.z;
  for (let i = 0; i < centers.length; i += 2) {
    const d = (centers[i] - car.x) ** 2 + (centers[i + 1] - car.z) ** 2;
    if (d < bestD) {
      bestD = d;
      bx = centers[i];
      bz = centers[i + 1];
    }
  }
  if (bestD > 400 ** 2) return; // 近くに道路が無ければそのまま
  car.x = bx;
  car.z = bz;
}

/** 読み込み済み範囲の半径 (m)。これを超えたら世界を貼り直す。 */
const WORLD_RADIUS = 3500;

/** 自車が読み込み範囲外に出た / GPS が遠方を返した場合に世界を再アンカーする */
function ensureWorldCovers(ll: LngLat): boolean {
  const l = frame.toLocal(ll);
  if (Math.hypot(l.x, l.z) < WORLD_RADIUS) return false;
  ui.toast("現在地の地図を読み込みます…");
  navigating = false;
  clearRoute();
  // 新しい原点 = 現在地。自車もそこへ移す (元の緯度経度に取り残さない)
  loadWorld(ll, ll);
  return true;
}

async function setDestination(ll: LngLat, label: string): Promise<void> {
  destLngLat = ll;
  const d = frame.toLocal(ll);
  if (destPin) scene.remove(destPin);
  destPin = makePin(d.x, d.z);
  scene.add(destPin);

  // 目的地方向へルートが見えるよう「目的地アップ」に切替
  setViewMode("destination");

  ui.toast(`ルート探索中… (${label})`);
  const r = await osrmRoute(car.lngLat, ll);
  if (!r) {
    ui.toast("ルートが見つかりませんでした");
    return;
  }
  currentRoute = r;
  routeLocal = r.coords.map((c) => frame.toLocal(c));
  stepIdx = 0;
  drawRouteLine();
  ui.showRoutePreview(fmtDistance(r.distance), fmtDuration(r.duration));
}

function drawRouteLine(): void {
  if (routeLine) scene.remove(routeLine);
  // 幅を持つリボンとして構築 (LineBasicMaterial は線幅 1px 固定で見えないため)
  const half = 7;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < routeLocal.length - 1; i++) {
    const a = routeLocal[i];
    const b = routeLocal[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * half;
    const nz = (dx / len) * half;
    const ya = elevSample(a.x, a.z) + 3.5;
    const yb = elevSample(b.x, b.z) + 3.5;
    const base = pos.length / 3;
    pos.push(
      a.x + nx, ya, a.z + nz,
      a.x - nx, ya, a.z - nz,
      b.x + nx, yb, b.z + nz,
      b.x - nx, yb, b.z - nz,
    );
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x33aaff,
    emissive: 0x2ea3ff,
    emissiveIntensity: 1.1,
    roughness: 0.5,
    side: THREE.DoubleSide,
    depthTest: false,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    polygonOffsetUnits: -8,
  });
  applyColony(mat, colony);
  routeLine = new THREE.Mesh(geo, mat);
  routeLine.name = "route";
  routeLine.renderOrder = 999;
  scene.add(routeLine);
}

function clearRoute(): void {
  if (routeLine) scene.remove(routeLine);
  if (destPin) scene.remove(destPin);
  routeLine = null;
  destPin = null;
  destLngLat = null;
  currentRoute = null;
  routeLocal = [];
  ui.hideBottomCard();
  ui.hideTurn();
}

function updateNav(): void {
  if (!navigating || !currentRoute || routeLocal.length < 2) return;

  let remain = 0;
  let nearestSeg = 0;
  let bestD = Infinity;
  for (let i = 0; i < routeLocal.length - 1; i++) {
    const d = pointSegDist(car.x, car.z, routeLocal[i], routeLocal[i + 1]);
    if (d < bestD) {
      bestD = d;
      nearestSeg = i;
    }
  }
  for (let i = nearestSeg; i < routeLocal.length - 1; i++) {
    remain += Math.hypot(
      routeLocal[i + 1].x - routeLocal[i].x,
      routeLocal[i + 1].z - routeLocal[i].z,
    );
  }
  const ratio = remain / Math.max(1, currentRoute.distance);
  ui.showNavInfo(fmtDistance(remain), fmtDuration(currentRoute.duration * ratio));

  while (
    stepIdx < currentRoute.steps.length - 1 &&
    dist2({ x: car.x, z: car.z }, frame.toLocal(currentRoute.steps[stepIdx].location)) <
      22 ** 2
  ) {
    stepIdx++;
  }
  const step =
    currentRoute.steps[Math.min(stepIdx + 1, currentRoute.steps.length - 1)];
  const sl = frame.toLocal(step.location);
  const dToTurn = Math.hypot(sl.x - car.x, sl.z - car.z);
  ui.setTurn(
    maneuverIcon(step.type, step.modifier),
    fmtDistance(dToTurn),
    step.name || describeManeuver(step.type, step.modifier, step.name),
  );

  if (remain < 25) {
    ui.toast("目的地に到着しました");
    endNav();
  }
}

function startNav(): void {
  if (!currentRoute) return;
  navigating = true;
  car.startAutopilot(currentRoute.coords);
  ui.setGpsActive(false);
  ui.toast("案内を開始します (デモ走行)");
}

function endNav(): void {
  navigating = false;
  car.stop();
  clearRoute();
}

const labels = new LabelLayer(app);

const ui = new UI(app, {
  onSearch: (q: string): Promise<GeocodeHit[]> => geocode(q, car.lngLat),
  onPickDestination: (hit) => setDestination(hit.lngLat, hit.label.split(",")[0]),
  onStartNav: startNav,
  onCancelRoute: endNav,
  onEndNav: endNav,
  onRecenter: () => {
    dragYaw = 0;
    dragPitch = 0;
  },
  onToggleGps: () => {
    if (car.mode === "gps") {
      car.stopGps();
      car.startFreedrive();
      ui.setGpsActive(false);
      ui.toast("フリードライブ (WASD)");
    } else {
      car.startGps();
      ui.setGpsActive(true);
      ui.toast("現在地を取得中…");
    }
  },
  onSetViewMode: (m) => setViewMode(m),
  onRadius: (r) => (colony.uColonyR.value = r),
  onThetaMax: (t) => (colony.uThetaMax.value = t),
  onHeightScale: (h) => {
    heightScale = h;
    ui.toast("建物高さは次回読み込みから反映されます");
  },
  onToggleLabels: (on) => labels.setVisible(on),
  onDriveSpeed: (mps) => (car.demoSpeed = mps),
  onCamDist: (d) => (camDist = d),
});

// GPS が読み込み範囲外を返したら世界を現在地へ貼り直す
car.onGpsFix = (ll) => {
  if (ensureWorldCovers(ll)) {
    ui.toast("現在地に移動しました");
    setViewMode("heading");
  }
};
car.onGpsError = (msg) => {
  ui.toast(msg);
  ui.setGpsActive(false);
  car.startFreedrive();
};

car.heading = START_HEADING;
forwardAngle = START_HEADING;
car.startFreedrive();
setViewMode("heading");
ui.toast("フリードライブ: WASD / 矢印キー・地図タップで目的地");
loadWorld(START, START);

// デバッグ / E2E フック
interface ColonyDebug {
  car: Car;
  colony: ColonyUniforms;
  scene: THREE.Scene;
  setDestination: (ll: LngLat, label: string) => Promise<void>;
  startNav: () => void;
  geocode: typeof geocode;
  readonly route: Route | null;
  readonly regionLoaded: boolean;
  readonly counts: Record<string, number>;
  elevAt: (x: number, z: number) => number;
  readonly labelItems: import("./labels").LabelItem[];
  raycastGround: (x: number, z: number) => number | null;
}
// 開発 / E2E 用フック。本番ビルド (?debug=1 指定時のみ) では公開しない。
const debugEnabled =
  import.meta.env.DEV ||
  new URLSearchParams(location.search).get("debug") === "1";
const colonyDebug: ColonyDebug = {
  car,
  colony,
  scene,
  setDestination,
  startNav,
  geocode,
  get route() {
    return currentRoute;
  },
  get regionLoaded() {
    return !!regionGroup;
  },
  elevAt: (x: number, z: number) => elevSample(x, z),
  get labelItems() {
    return lastLabelItems;
  },
  raycastGround: (x: number, z: number) => {
    // ビュー空間でなくローカル空間の地形三角形へ真下からレイを飛ばし、
    // elevSample() と描画メッシュが一致しているか検証する用
    if (!terrainMesh) return null;
    const rc = new THREE.Raycaster(
      new THREE.Vector3(x, 9000, z),
      new THREE.Vector3(0, -1, 0),
    );
    // コロニー変形は頂点シェーダ側なので CPU レイキャストは変形前ジオメトリに当たる
    const hit = rc.intersectObject(terrainMesh, false)[0];
    return hit ? hit.point.y : null;
  },
  get counts() {
    const c: Record<string, number> = {};
    scene.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g?.attributes?.position) {
        c[o.name || o.type] = g.attributes.position.count;
      }
    });
    return c;
  },
};
if (debugEnabled) {
  (window as unknown as { __colony: ColonyDebug }).__colony = colonyDebug;
}

const clock = new THREE.Clock();
function tick(): void {
  const raw = clock.getDelta();
  // 走行の積分は大きな dt で飛ばないよう強く抑える
  const dt = Math.min(0.05, raw);
  // 視点の追従は実時間で行う。物理用の dt を使うと、重い場面 (低 FPS) で
  // 表示モードを切り替えても向きがいつまでも変わらない。
  const dtView = Math.min(0.3, raw);
  car.update(dt);
  colony.uCarLocal.value.set(car.x, car.z);
  colony.uCarElev.value = car.elev;
  updateForward(dtView);
  updateNav();

  carMesh.position.set(0, 0, 0);
  const [he, hn] = car.headingVec();
  carMesh.rotation.y = Math.atan2(he, hn);

  // destPin はコロニー変形シェーダ付きの静的ジオメトリ (毎フレーム更新不要)

  // カメラ: 自車の真後ろ上空から、やや上向きに前方を見る (TPS)。
  // カメラ・注視点はビュー空間 (自車が常に原点)。
  // 画面の下半分に自車周辺の道路、上半分にせり上がったコロニー壁が入る画角。
  const f = colony.uForward.value;
  const yaw = Math.atan2(f.x, f.y) + dragYaw;
  // 密集市街地では屋上より低いと隣のビルの壁しか見えないので、やや高めに構える
  const camY = 18 + camDist * 0.8;
  camera.position.set(-Math.sin(yaw) * camDist, camY, -Math.cos(yaw) * camDist);
  const pitch = THREE.MathUtils.clamp(BASE_PITCH + dragPitch, -0.4, 1.2);
  const lookDist = 260;
  camera.lookAt(
    Math.sin(yaw) * lookDist,
    camY + Math.tan(pitch) * lookDist,
    Math.cos(yaw) * lookDist,
  );

  labels.update(camera, colony);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function dist2(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}
function pointSegDist(
  px: number,
  pz: number,
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  let t = ((px - a.x) * dx + (pz - a.z) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
}
