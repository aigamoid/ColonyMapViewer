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

  /** デモ走行の速度 (m/s)。オートパイロットの巡航速度・フリードライブの上限。 */
  demoSpeed = 14;
  /** GPS の水平精度 (m)。未取得なら null */
  accuracy: number | null = null;
  /** GPS 座標を受け取ったときのコールバック (世界の再アンカー判定用) */
  onGpsFix: ((ll: LngLat) => void) | null = null;
  /** GPS エラー通知 */
  onGpsError: ((msg: string) => void) | null = null;

  private keys = new Set<string>();
  private path: { x: number; z: number }[] = [];
  private pathI = 0;
  private geoWatch: number | null = null;
  private lastFix: { x: number; z: number } | null = null;

  constructor(frame: LocalFrame) {
    this.frame = frame;
    addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
  }

  get lngLat(): LngLat {
    return this.frame.toLngLat(this.x, this.z);
  }

  /**
   * ローカル原点を貼り直す。
   * `at` を渡すとその緯度経度へ自車を移す (GPS で遠方へ飛んだ場合)。
   * 省略時は現在の緯度経度を保ったまま x/z を新 frame 基準へ変換する。
   */
  setFrame(frame: LocalFrame, at?: LngLat): void {
    const here = at ?? this.frame.toLngLat(this.x, this.z);
    this.frame = frame;
    const l = frame.toLocal(here);
    this.x = l.x;
    this.z = l.z;
    this.lastFix = null;
    // 経路はローカル座標依存なので破棄
    this.path = [];
    this.pathI = 0;
    if (this.mode === "autopilot") this.mode = "idle";
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
    if (!navigator.geolocation) {
      this.onGpsError?.("この端末は位置情報に対応していません");
      return;
    }
    if (!isSecureContext) {
      this.onGpsError?.("位置情報は HTTPS でのみ利用できます");
      return;
    }
    this.stopGps();
    this.mode = "gps";
    this.speed = 0;
    this.lastFix = null;
    this.geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        const ll = { lng: p.coords.longitude, lat: p.coords.latitude };
        this.accuracy = p.coords.accuracy;

        // 読み込み済み範囲の外なら世界を貼り直してもらう (setFrame が呼ばれる)
        this.onGpsFix?.(ll);

        const l = this.frame.toLocal(ll);
        // 進行方向: GPS heading があればそれ、無ければ移動ベクトルから推定
        if (p.coords.heading != null && !Number.isNaN(p.coords.heading)) {
          this.heading = (p.coords.heading * Math.PI) / 180;
        } else if (this.lastFix) {
          const dx = l.x - this.lastFix.x;
          const dz = l.z - this.lastFix.z;
          if (Math.hypot(dx, dz) > 2) this.heading = Math.atan2(dx, dz);
        }
        this.x = l.x;
        this.z = l.z;
        this.lastFix = { x: l.x, z: l.z };
        this.speed = p.coords.speed ?? 0;
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "位置情報が拒否されました (ブラウザの設定で許可してください)"
            : err.code === err.POSITION_UNAVAILABLE
              ? "位置を取得できませんでした"
              : "位置情報がタイムアウトしました";
        this.onGpsError?.(msg);
        this.stopGps();
        this.mode = "idle";
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  stopGps(): void {
    if (this.geoWatch != null) navigator.geolocation.clearWatch(this.geoWatch);
    this.geoWatch = null;
    this.accuracy = null;
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
    this.speed = this.demoSpeed;
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
    const maxSpeed = this.demoSpeed;
    const accel = Math.max(4, maxSpeed * 0.6);
    if (k.has("w") || k.has("arrowup")) this.speed = Math.min(maxSpeed, this.speed + accel * dt);
    else if (k.has("s") || k.has("arrowdown"))
      this.speed = Math.max(-maxSpeed * 0.4, this.speed - accel * dt);
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
    // 走行中でも速度スライダーを即座に反映する
    this.speed = this.demoSpeed;
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
