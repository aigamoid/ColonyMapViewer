import * as THREE from "three";

/**
 * コロニー変形。
 *
 * ローカル座標 (x=東, y=上, z=北) の平坦なジオメトリを、半径 R の円柱の内面に
 * 巻き付ける頂点シェーダ変形。自車は円柱内面の最下部 (ビュー空間の原点) に立ち、
 * "forward" 方向に沿って地面が上へせり上がっていく。
 *
 * 変形はまず自車ローカル座標 (uCarLocal / uCarElev) を引いて自車中心に平行移動し、
 * その相対座標 pc に対して行う:
 *   s     = forward 方向への距離         dot(pc.xz, forward)
 *   t     = axis 方向への距離            dot(pc.xz, axis)   axis = forward を +90°
 *   h     = 相対標高                     pc.y
 *   θ     = s / R · mix
 *   radial= R - h
 *   view  = forward·(radial·sinθ) + axis·t + up·(R - radial·cosθ)
 */

export interface ColonyUniforms {
  uColonyR: { value: number };
  uForward: { value: THREE.Vector2 };
  uAxis: { value: THREE.Vector2 };
  uColonyMix: { value: number };
  uCarLocal: { value: THREE.Vector2 };
  uCarElev: { value: number };
  /**
   * 巻き上げ角の上限 (rad)。
   * 純粋な円柱だと θ=s/R がどこまでも増え、遠方が頭上を越えて背後へ回り込んでしまう
   * (「遠距離の目標を目視できる」という目的が達成できない)。
   * そこで θ = θmax·tanh(s / (R·θmax)) と飽和させる。
   * 近距離では θ ≈ s/R で円柱と一致し、遠距離は θmax に漸近して画面上端に積み上がる。
   * 0 以下にすると飽和なし (真の円柱)。
   *
   * θ が 90° を超えると建物の「上」方向が観測者を向き、遠景が
   * 屋根の並んだ一枚の壁に潰れて何も読み取れなくなる。
   * そのため既定は 1.15 rad (約 66°) 程度に抑える。
   */
  uThetaMax: { value: number };
}

export function createColonyUniforms(radius = 1800, thetaMax = 1.15): ColonyUniforms {
  return {
    uColonyR: { value: radius },
    uForward: { value: new THREE.Vector2(0, 1) },
    uAxis: { value: new THREE.Vector2(-1, 0) },
    uColonyMix: { value: 1 },
    uCarLocal: { value: new THREE.Vector2(0, 0) },
    uCarElev: { value: 0 },
    uThetaMax: { value: thetaMax },
  };
}

/** 前方距離 s -> 巻き上げ角 θ (CPU 側)。GLSL の colonyTheta と同じ式。 */
export function colonyTheta(s: number, u: ColonyUniforms): number {
  const lin = s / u.uColonyR.value;
  const tm = u.uThetaMax.value;
  return tm <= 0 ? lin : tm * Math.tanh(lin / tm);
}

/** θ -> 前方距離 s (逆変換)。画面ピックで使う。 */
export function colonyThetaInverse(theta: number, u: ColonyUniforms): number {
  const mix = u.uColonyMix.value || 1;
  const t = theta / mix;
  const tm = u.uThetaMax.value;
  if (tm <= 0) return t * u.uColonyR.value;
  const y = Math.max(-0.999, Math.min(0.999, t / tm));
  return u.uColonyR.value * tm * Math.atanh(y);
}

/** forward(東,北) から axis を更新する (forward を +90° 回転) */
export function setForward(u: ColonyUniforms, east: number, north: number): void {
  const len = Math.hypot(east, north) || 1;
  const fe = east / len;
  const fn = north / len;
  u.uForward.value.set(fe, fn);
  u.uAxis.value.set(-fn, fe);
}

const GLSL_WARP = /* glsl */ `
uniform float uColonyR;
uniform vec2  uForward;
uniform vec2  uAxis;
uniform float uColonyMix;
uniform vec2  uCarLocal;
uniform float uCarElev;
uniform float uThetaMax;

// WebGL1 の GLSL ES 1.0 には tanh が無いので自前実装 (大きな |x| でも安定)
float colonyTanh(float x) {
  float e = exp(-2.0 * abs(x));
  float t = (1.0 - e) / (1.0 + e);
  return x < 0.0 ? -t : t;
}

// 前方距離 s -> 巻き上げ角 θ。θmax で飽和させ遠方が背後へ回り込むのを防ぐ。
float colonyTheta(float s) {
  float lin = s / uColonyR;
  return uThetaMax <= 0.0 ? lin : uThetaMax * colonyTanh(lin / uThetaMax);
}

vec3 colonyWarpPos(vec3 p) {
  vec3 pc = vec3(p.x - uCarLocal.x, p.y - uCarElev, p.z - uCarLocal.y);
  float s = dot(pc.xz, uForward);
  float t = dot(pc.xz, uAxis);
  float h = pc.y;

  // 変形なし (平面) の位置
  vec2 flatH = uForward * s + uAxis * t;
  vec3 flatP = vec3(flatH.x, h, flatH.y);

  // 円柱内面へ巻き付けた位置。
  // 高さは円柱の「軸へ向かう」方向なので、h が R に近づくと建物が
  // 軸(=観測者付近)を突き抜けて視界を塞ぐ。軸から一定距離を残すようクランプする。
  float theta = colonyTheta(s);
  float radial = max(uColonyR - h, uColonyR * 0.3);
  vec2 wh = uForward * (radial * sin(theta)) + uAxis * t;
  vec3 warpP = vec3(wh.x, uColonyR - radial * cos(theta), wh.y);

  // uColonyMix は「平面 ←→ 巻き付け」の補間。
  // theta にだけ mix を掛けると fwd = radial*sin(0) = 0 になり
  // 全ジオメトリが 1 本の線へ潰れてしまうので、位置そのものを補間する。
  return mix(flatP, warpP, uColonyMix);
}

vec3 colonyWarpNormal(vec3 n, vec3 p) {
  vec3 pc = vec3(p.x - uCarLocal.x, p.y - uCarElev, p.z - uCarLocal.y);
  float theta = colonyTheta(dot(pc.xz, uForward)) * uColonyMix;
  float c = cos(theta);
  float sn = sin(theta);
  float nf = dot(n.xz, uForward);
  float na = dot(n.xz, uAxis);
  float nu = n.y;
  float outF = nf * c - nu * sn;
  float outU = nf * sn + nu * c;
  vec2 horiz = uForward * outF + uAxis * na;
  return normalize(vec3(horiz.x, outU, horiz.y));
}
`;

/**
 * three マテリアルにコロニー変形を注入する。uniforms オブジェクトは全マテリアルで共有する。
 * nearFade=true で、自車の至近 (カメラと自車の間) にある面をフェード/破棄する
 * (TPS カメラが手前のビルに埋まるのを防ぐ)。
 */
export interface ColonyOptions {
  /** 自車至近の面をディザ discard する (カメラがビルに埋まるのを防ぐ) */
  nearFade?: boolean;
  /**
   * 遠方ほど高さを圧縮する。建物用。
   * コロニー内面では建物の「上」は円柱軸 = 観測者の方を向くため、
   * 遠方の高層ビルが道路や目的地を隠してしまう。近距離は実寸のまま、
   * 遠距離は平たくすることで「遠くまで見通せる」というこのアプリの目的を成立させる。
   * 有効にするジオメトリは aBaseY (その建物の接地高さ) 属性を持つ必要がある。
   */
  heightFalloff?: boolean;
}

export function applyColony(
  material: THREE.Material,
  u: ColonyUniforms,
  opts: ColonyOptions = {},
): void {
  const { nearFade = false, heightFalloff = false } = opts;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uColonyR = u.uColonyR;
    shader.uniforms.uForward = u.uForward;
    shader.uniforms.uAxis = u.uAxis;
    shader.uniforms.uColonyMix = u.uColonyMix;
    shader.uniforms.uCarLocal = u.uCarLocal;
    shader.uniforms.uCarElev = u.uCarElev;
    shader.uniforms.uThetaMax = u.uThetaMax;

    // 遠方の建物を平たくするための頂点前処理。
    // ついでに「その建物の高さ」を varying で渡し、色に段差を付けて
    // 一様な灰色の塊に見えないようにする。
    const adjust = heightFalloff
      ? `
  vec3 colonyPos = position.xyz;
  float bldgH = 0.0;
  {
    float relH = colonyPos.y - aBaseY;
    bldgH = relH;
    float d = length(colonyPos.xz - uCarLocal);
    colonyPos.y = aBaseY + relH * mix(1.0, 0.14, smoothstep(70.0, 420.0, d));
  }
  vBldgH = bldgH;`
      : `  vec3 colonyPos = position.xyz;`;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\n${GLSL_WARP}\nvarying float vCamDist;${
          heightFalloff ? "\nattribute float aBaseY;\nvarying float vBldgH;" : ""
        }`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>\n  objectNormal = colonyWarpNormal(objectNormal, position.xyz);`,
      )
      .replace(
        "#include <begin_vertex>",
        `${adjust}\n  vec3 transformed = colonyWarpPos(colonyPos);`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>\n  vCamDist = -mvPosition.z;`,
      );

    if (nearFade) {
      // TPS カメラが建物の内部/直前に入り込んで視界を塞ぐのを防ぐ。
      //
      // 判定は「カメラからの距離」で行う。自車からの距離だと、カメラを包み込む
      // 大きな建物 (自車がビルの敷地内に居る場合など) の遠い側の壁が残ってしまう。
      //
      // アルファ合成は使わない: 建物は 1 個の巨大メッシュに統合されているため
      // transparent + depthWrite:false にすると建物同士の遮蔽が壊れ、
      // 街全体が半透明スラブの重なり (灰色の霞) になってしまう。
      // 代わりにスクリーン空間ディザで discard する (マテリアルは不透明のまま)。
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vCamDist;\nvarying float vBldgH;",
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
  {
    // 低層はやや暗く沈ませ、高層はわずかに明るくして街の起伏を読めるようにする
    float lv = smoothstep(6.0, 90.0, vBldgH);
    gl_FragColor.rgb *= mix(0.78, 1.1, lv);
  }`,
        )
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
  {
    float nf = smoothstep(55.0, 150.0, vCamDist);
    if (nf < 1.0) {
      // 4x4 Bayer 秩序ディザ。白色ノイズよりざらつきが目立たない。
      int bx = int(mod(gl_FragCoord.x, 4.0));
      int by = int(mod(gl_FragCoord.y, 4.0));
      float bayer[16];
      bayer[0]=0.0;  bayer[1]=8.0;  bayer[2]=2.0;  bayer[3]=10.0;
      bayer[4]=12.0; bayer[5]=4.0;  bayer[6]=14.0; bayer[7]=6.0;
      bayer[8]=3.0;  bayer[9]=11.0; bayer[10]=1.0; bayer[11]=9.0;
      bayer[12]=15.0;bayer[13]=7.0; bayer[14]=13.0;bayer[15]=5.0;
      float th = bayer[by * 4 + bx] / 16.0;
      if (nf < th) discard;
    }
  }`,
        );
      material.transparent = false;
      material.depthWrite = true;
    }
  };
  material.needsUpdate = true;
}

/**
 * ローカル(東,北,標高) を CPU 側でビュー空間へ変換 (ピン・ラベル等の非シェーダ要素用)。
 * `out` を渡すと確保せずそこへ書き込む (毎フレーム大量に呼ぶ用途向け)。
 */
export function colonyWarpCPU(
  x: number,
  y: number,
  z: number,
  u: ColonyUniforms,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const pcx = x - u.uCarLocal.value.x;
  const pcy = y - u.uCarElev.value;
  const pcz = z - u.uCarLocal.value.y;
  const f = u.uForward.value;
  const a = u.uAxis.value;
  const s = pcx * f.x + pcz * f.y;
  const t = pcx * a.x + pcz * a.y;
  const theta = colonyTheta(s, u);
  const radial = Math.max(u.uColonyR.value - pcy, u.uColonyR.value * 0.3);
  const fwd = radial * Math.sin(theta);
  const up = u.uColonyR.value - radial * Math.cos(theta);
  // GLSL 版と同じく「平面 ←→ 巻き付け」を位置で補間する
  const mix = u.uColonyMix.value;
  const lerp = (flat: number, warped: number) => flat + (warped - flat) * mix;
  const vx = lerp(f.x * s + a.x * t, f.x * fwd + a.x * t);
  const vy = lerp(pcy, up);
  const vz = lerp(f.y * s + a.y * t, f.y * fwd + a.y * t);
  return out ? out.set(vx, vy, vz) : new THREE.Vector3(vx, vy, vz);
}
