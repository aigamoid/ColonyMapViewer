import type { LngLat } from "./geo";

// 無料・APIキー不要のデモ用エンドポイント。
// 本番は自前ホスト (OSRM / Valhalla, Nominatim / Photon) に差し替える。
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org";

export interface GeocodeHit {
  label: string;
  lngLat: LngLat;
}

export async function geocode(query: string, near?: LngLat): Promise<GeocodeHit[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "6",
    "accept-language": "ja",
  });
  if (near) {
    const d = 0.5;
    params.set(
      "viewbox",
      `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`,
    );
  }
  const res = await fetch(`${NOMINATIM}/search?${params}`, {
    headers: { "Accept-Language": "ja" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
  }>;
  return data.map((d) => ({
    label: d.display_name,
    lngLat: { lng: parseFloat(d.lon), lat: parseFloat(d.lat) },
  }));
}

/**
 * 逆ジオコーディング (現在地の住所)。
 *
 * ベクタータイルの place ラベルは「点」なので最近傍を取ると
 * 隣の区の重心のほうが近い、といったことが起きる (丸の内で「中央区」になる等)。
 * 正しい行政区画は境界ポリゴンが要るため、ここは Nominatim に問い合わせる。
 * 利用規約に配慮して呼び出し側で十分に間引くこと。
 */
export async function reverseGeocode(ll: LngLat): Promise<string[] | null> {
  const params = new URLSearchParams({
    lat: String(ll.lat),
    lon: String(ll.lng),
    format: "jsonv2",
    zoom: "16",
    "accept-language": "ja",
  });
  try {
    const res = await fetch(`${NOMINATIM}/reverse?${params}`, {
      headers: { "Accept-Language": "ja" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: Record<string, string> };
    const a = data.address;
    if (!a) return null;
    const parts = [
      a["state"] ?? a["province"] ?? a["region"],
      a["city"] ?? a["town"] ?? a["county"] ?? a["municipality"],
      a["city_district"] ?? a["suburb"] ?? a["borough"],
      a["neighbourhood"] ?? a["quarter"],
    ].filter((v): v is string => !!v);
    // 重複や包含関係 (例: 東京都 / 東京) を落とす
    const out: string[] = [];
    for (const p of parts) {
      if (!out.some((q) => q === p || q.includes(p) || p.includes(q))) out.push(p);
    }
    return out.slice(0, 3);
  } catch {
    return null;
  }
}

export interface RouteStep {
  /** このステップ開始時点での残距離ではなく、ステップ自体の距離(m) */
  distance: number;
  /** maneuver 位置 */
  location: LngLat;
  type: string; // turn, merge, roundabout, arrive, depart, ...
  modifier?: string; // left, right, slight left, ...
  name: string;
  instruction: string;
}

export interface Route {
  /** ルート形状 (経度緯度列) */
  coords: LngLat[];
  distance: number; // m
  duration: number; // s
  steps: RouteStep[];
}

export async function route(from: LngLat, to: LngLat): Promise<Route | null> {
  const url =
    `${OSRM}/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=geojson&steps=true&annotations=false`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.length) return null;
  const r = data.routes[0];
  const coords: LngLat[] = r.geometry.coordinates.map(
    ([lng, lat]: [number, number]) => ({ lng, lat }),
  );
  const steps: RouteStep[] = [];
  for (const leg of r.legs) {
    for (const s of leg.steps) {
      const m = s.maneuver;
      steps.push({
        distance: s.distance,
        location: { lng: m.location[0], lat: m.location[1] },
        type: m.type,
        modifier: m.modifier,
        name: s.name ?? "",
        instruction: describeManeuver(m.type, m.modifier, s.name),
      });
    }
  }
  return { coords, distance: r.distance, duration: r.duration, steps };
}

export function describeManeuver(
  type: string,
  modifier: string | undefined,
  name: string,
): string {
  const dir: Record<string, string> = {
    left: "左折",
    right: "右折",
    "slight left": "斜め左",
    "slight right": "斜め右",
    "sharp left": "鋭角に左",
    "sharp right": "鋭角に右",
    straight: "直進",
    uturn: "Uターン",
  };
  const road = name ? `「${name}」を` : "";
  switch (type) {
    case "depart":
      return `${road}出発`;
    case "arrive":
      return "目的地に到着";
    case "roundabout":
    case "rotary":
      return `ロータリーを進む`;
    case "merge":
      return `${road}合流 (${dir[modifier ?? "straight"] ?? ""})`;
    case "fork":
      return `分岐を${dir[modifier ?? "straight"] ?? "進む"}`;
    case "end of road":
      return `突き当たりを${dir[modifier ?? ""] ?? "進む"}`;
    case "new name":
    case "continue":
      return `${road}直進`;
    default:
      return `${road}${dir[modifier ?? ""] ?? "進む"}`;
  }
}

export function maneuverIcon(type: string, modifier?: string): string {
  if (type === "arrive") return "◎";
  if (type === "depart") return "▲";
  if (type === "roundabout" || type === "rotary") return "↻";
  switch (modifier) {
    case "left":
    case "sharp left":
      return "↰";
    case "slight left":
      return "↖";
    case "right":
    case "sharp right":
      return "↱";
    case "slight right":
      return "↗";
    case "uturn":
      return "⟲";
    default:
      return "↑";
  }
}
