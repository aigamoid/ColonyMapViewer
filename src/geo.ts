// Web Mercator / タイル座標 / ローカルENU(メートル) の相互変換。

export const TILE_SIZE = 512;
const EARTH_RADIUS = 6378137;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS;

export interface LngLat {
  lng: number;
  lat: number;
}

/** 経度緯度 -> Web Mercator メートル (EPSG:3857) */
export function lngLatToMeters({ lng, lat }: LngLat): [number, number] {
  const x = (lng / 180) * ORIGIN_SHIFT;
  const y =
    (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180) / 180) *
    ORIGIN_SHIFT;
  return [x, y];
}

/** Web Mercator メートル -> 経度緯度 */
export function metersToLngLat(x: number, y: number): LngLat {
  const lng = (x / ORIGIN_SHIFT) * 180;
  let lat = (y / ORIGIN_SHIFT) * 180;
  lat =
    (180 / Math.PI) *
    (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return { lng, lat };
}

/** 緯度に応じた Web Mercator の歪み補正係数 (メートル/mercator-unit) */
export function mercatorScale(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

export function tileToLngLat(x: number, y: number, z: number): LngLat {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lng, lat: (latRad * 180) / Math.PI };
}

/**
 * ローカル接平面 (ENU) の原点を保持し、経度緯度 <-> ローカルメートル(x=東, z=北) を変換する。
 * コロニー変形はこのローカル座標に対して行う。
 */
export class LocalFrame {
  readonly origin: LngLat;
  private readonly ox: number;
  private readonly oy: number;
  private readonly scale: number;

  constructor(origin: LngLat) {
    this.origin = origin;
    const [ox, oy] = lngLatToMeters(origin);
    this.ox = ox;
    this.oy = oy;
    this.scale = mercatorScale(origin.lat);
  }

  /** 経度緯度 -> ローカル {x: 東(m), z: 北(m)} */
  toLocal(ll: LngLat): { x: number; z: number } {
    const [mx, my] = lngLatToMeters(ll);
    return { x: (mx - this.ox) * this.scale, z: (my - this.oy) * this.scale };
  }

  /** Web Mercator メートルを直接ローカルへ (タイルジオメトリ用) */
  metersToLocal(mx: number, my: number): { x: number; z: number } {
    return { x: (mx - this.ox) * this.scale, z: (my - this.oy) * this.scale };
  }

  /** ローカルメートル -> 経度緯度 */
  toLngLat(x: number, z: number): LngLat {
    return metersToLngLat(this.ox + x / this.scale, this.oy + z / this.scale);
  }
}
