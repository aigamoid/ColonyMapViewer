import * as THREE from "three";
import { LocalFrame, LngLat, lngLatToTile } from "./geo";
import {
  ColonyUniforms,
  createColonyUniforms,
  setForward,
  applyColony,
  colonyWarpCPU,
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

// 初期位置: サンフランシスコ Embarcadero (湾に開けて奥に高層ビル群 = コロニー曲面が映える)
const START: LngLat = { lng: -122.3937, lat: 37.7955 };
const TILE_Z = 14; // OpenFreeMap planet の最大ズーム
const TILE_RING = 2;
const TERRAIN_Z = 13;
const TERRAIN_RING = 2;
const BUILDING_EXAGGERATION = 1.6;
const DEFAULT_R = 650;

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

const colony: ColonyUniforms = createColonyUniforms(DEFAULT_R);
const frame = new LocalFrame(START);
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
let heightScale = BUILDING_EXAGGERATION;
let elevSample: (x: number, z: number) => number = () => 0;
let viewMode: ViewModeId = "north";
let camDist = 16;
let dragYaw = 0;
let dragPitch = 0;

let destPin: THREE.Group | null = null;
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

function makePin(): THREE.Group {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1f6feb, roughness: 0.4 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 16), mat);
  head.position.y = 34;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 34, 8), mat);
  stem.position.y = 17;
  grp.add(head, stem);
  grp.name = "destPin";
  return grp;
}

function updateForward(): void {
  if (viewMode === "north") {
    setForward(colony, 0, 1);
  } else if (viewMode === "heading") {
    const [e, n] = car.headingVec();
    setForward(colony, e, n);
  } else {
    if (destLngLat) {
      const d = frame.toLocal(destLngLat);
      setForward(colony, d.x - car.x, d.z - car.z);
    } else {
      const [e, n] = car.headingVec();
      setForward(colony, e, n);
    }
  }
}

// カメラ操作 & 地図クリック
{
  let dragging = false;
  let lx = 0;
  let ly = 0;
  let downX = 0;
  let downY = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = true;
    lx = downX = e.clientX;
    ly = downY = e.clientY;
  });
  addEventListener("pointerup", (e) => {
    dragging = false;
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
  const s = theta * R;
  return {
    x: car.x + f.x * s + a.x * relLat,
    z: car.z + f.y * s + a.y * relLat,
  };
}

async function loadWorld(): Promise<void> {
  ui.toast("地図データを読み込み中…");
  const [txf, tyf] = lngLatToTile(START.lng, START.lat, TILE_Z);
  const [ttxf, ttyf] = lngLatToTile(START.lng, START.lat, TERRAIN_Z);

  const terrain = await loadTerrain(
    frame,
    TERRAIN_Z,
    Math.floor(ttxf),
    Math.floor(ttyf),
    TERRAIN_RING,
  );
  car.setElevationSampler(terrain.sample);
  elevSample = terrain.sample;
  if (terrain.mesh && terrain.material) {
    applyColony(terrain.material, colony);
    scene.add(terrain.mesh);
  }
  addColonyGrid();

  const region = await loadRegion(
    frame,
    TILE_Z,
    Math.floor(txf),
    Math.floor(tyf),
    TILE_RING,
    heightScale,
    terrain.sample,
  );
  for (const m of region.materials) applyColony(m, colony, m === region.buildingMat);
  regionGroup = region.group;
  scene.add(region.group);
  ui.toast(terrain.mesh ? "準備完了" : "準備完了 (地形データなし)");
}

async function setDestination(ll: LngLat, label: string): Promise<void> {
  destLngLat = ll;
  if (destPin) scene.remove(destPin);
  destPin = makePin();
  scene.add(destPin);

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
  const half = 5;
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
    const ya = elevSample(a.x, a.z) + 2.2;
    const yb = elevSample(b.x, b.z) + 2.2;
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
    color: 0x2ea3ff,
    emissive: 0x1f6feb,
    emissiveIntensity: 0.6,
    roughness: 0.5,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    polygonOffsetUnits: -8,
  });
  applyColony(mat, colony);
  routeLine = new THREE.Mesh(geo, mat);
  routeLine.name = "route";
  routeLine.renderOrder = 5;
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
      ui.toast("GPS 追従を開始");
    }
  },
  onSetViewMode: (m) => {
    viewMode = m;
  },
  onRadius: (r) => (colony.uColonyR.value = r),
  onHeightScale: (h) => {
    heightScale = h;
    ui.toast("建物高さは次回読み込みから反映されます");
  },
  onCamDist: (d) => (camDist = d),
});

car.startFreedrive();
ui.toast("フリードライブ: WASD / 矢印キー・地図タップで目的地");
loadWorld();

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
}
(window as unknown as { __colony: ColonyDebug }).__colony = {
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

const clock = new THREE.Clock();
function tick(): void {
  const dt = Math.min(0.05, clock.getDelta());
  car.update(dt);
  colony.uCarLocal.value.set(car.x, car.z);
  colony.uCarElev.value = car.elev;
  updateForward();
  updateNav();

  carMesh.position.set(0, 0, 0);
  const [he, hn] = car.headingVec();
  carMesh.rotation.y = Math.atan2(he, hn);

  if (destPin && destLngLat) {
    const d = frame.toLocal(destLngLat);
    destPin.position.copy(colonyWarpCPU(d.x, elevSample(d.x, d.z), d.z, colony));
  }

  // カメラ: 自車のやや後方・上空から、ほぼ水平に前方を見る。
  // コロニーの壁がせり上がって上半分を埋める。
  const f = colony.uForward.value;
  const yaw = Math.atan2(f.x, f.y) + dragYaw;
  // カメラ・注視点はビュー空間 (自車が常に原点)。
  // 屋上より上から市街地越しにコロニーのせり上がりを見る。
  camera.position.set(
    -Math.sin(yaw) * camDist,
    22 + camDist * 1.1,
    -Math.cos(yaw) * camDist,
  );
  const lookDist = 460;
  const lookUp = 250 + dragPitch * -700;
  camera.lookAt(Math.sin(yaw) * lookDist, lookUp, Math.cos(yaw) * lookDist);

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
