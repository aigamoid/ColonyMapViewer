import { LocalFrame, LngLat } from "./geo";

export type DriveMode = "idle" | "gps" | "freedrive" | "autopilot";

/**
 * 自車の状態。ローカル座標 (x=東, z=北, メートル) と heading (ラジアン, 北=0, 東回り+) を保持。
 */
export class Car {
  frame: LocalFrame;
  x = 0;
  z = 0;
  elev = 0;
  heading = 0; // rad
  speed = 0; // m/s
  mode: DriveMode = "idle";

  private keys = new Set<string>();
  private path: { x: number; z: number }[] = [];
  private pathI = 0;
  private geoWatch: number | null = null;

  constructor(frame: LocalFrame) {
    this.frame = frame;
    addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
  }

  get lngLat(): LngLat {
    return this.frame.toLngLat(this.x, this.z);
  }

  setElevationSampler(fn: (x: number, z: number) => number): void {
    this.sampleElev = fn;
  }
  private sampleElev: (x: number, z: number) => number = () => 0;

  startFreedrive(): void {
    this.stopGps();
    this.mode = "freedrive";
  }

  startGps(): void {
    if (!navigator.geolocation) return;
    this.mode = "gps";
    this.geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        const l = this.frame.toLocal({
          lng: p.coords.longitude,
          lat: p.coords.latitude,
        });
        this.x = l.x;
        this.z = l.z;
        if (p.coords.heading != null && !Number.isNaN(p.coords.heading)) {
          this.heading = (p.coords.heading * Math.PI) / 180;
        }
        this.speed = p.coords.speed ?? 0;
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000 },
    );
  }

  stopGps(): void {
    if (this.geoWatch != null) navigator.geolocation.clearWatch(this.geoWatch);
    this.geoWatch = null;
  }

  /** ルート座標列に沿って自動走行を開始 */
  startAutopilot(coords: LngLat[]): void {
    this.stopGps();
    this.path = coords.map((c) => this.frame.toLocal(c));
    this.pathI = 0;
    if (this.path.length) {
      this.x = this.path[0].x;
      this.z = this.path[0].z;
    }
    this.mode = "autopilot";
    this.speed = 14; // ~50 km/h
  }

  stop(): void {
    this.mode = "idle";
    this.speed = 0;
  }

  update(dt: number): void {
    if (this.mode === "freedrive") this.updateFreedrive(dt);
    else if (this.mode === "autopilot") this.updateAutopilot(dt);

    this.elev = this.sampleElev(this.x, this.z);
  }

  private updateFreedrive(dt: number): void {
    const k = this.keys;
    const accel = 8;
    const maxSpeed = 25;
    if (k.has("w") || k.has("arrowup")) this.speed = Math.min(maxSpeed, this.speed + accel * dt);
    else if (k.has("s") || k.has("arrowdown")) this.speed = Math.max(-8, this.speed - accel * dt);
    else this.speed *= 1 - Math.min(1, 2 * dt);

    const turn = 1.6 * dt * (this.speed >= 0 ? 1 : -1);
    if (k.has("a") || k.has("arrowleft")) this.heading -= turn;
    if (k.has("d") || k.has("arrowright")) this.heading += turn;

    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
  }

  private updateAutopilot(dt: number): void {
    if (this.pathI >= this.path.length - 1) {
      this.speed = 0;
      return;
    }
    let remain = this.speed * dt;
    while (remain > 0 && this.pathI < this.path.length - 1) {
      const cur = { x: this.x, z: this.z };
      const next = this.path[this.pathI + 1];
      const dx = next.x - cur.x;
      const dz = next.z - cur.z;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-3) {
        this.pathI++;
        continue;
      }
      if (remain >= segLen) {
        this.x = next.x;
        this.z = next.z;
        this.pathI++;
        remain -= segLen;
      } else {
        this.x += (dx / segLen) * remain;
        this.z += (dz / segLen) * remain;
        this.heading = Math.atan2(dx, dz);
        remain = 0;
      }
    }
  }

  /** 進行方向の水平ベクトル (東, 北) */
  headingVec(): [number, number] {
    return [Math.sin(this.heading), Math.cos(this.heading)];
  }
}
