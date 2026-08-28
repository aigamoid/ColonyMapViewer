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
}

export function createColonyUniforms(radius = 1800): ColonyUniforms {
  return {
    uColonyR: { value: radius },
    uForward: { value: new THREE.Vector2(0, 1) },
    uAxis: { value: new THREE.Vector2(-1, 0) },
    uColonyMix: { value: 1 },
    uCarLocal: { value: new THREE.Vector2(0, 0) },
    uCarElev: { value: 0 },
  };
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

vec3 colonyWarpPos(vec3 p) {
  vec3 pc = vec3(p.x - uCarLocal.x, p.y - uCarElev, p.z - uCarLocal.y);
  float s = dot(pc.xz, uForward);
  float t = dot(pc.xz, uAxis);
  float h = pc.y;
  float theta = (s / uColonyR) * uColonyMix;
  float radial = uColonyR - h;
  float fwd = radial * sin(theta);
  float up  = uColonyR - radial * cos(theta);
  vec2 horiz = uForward * fwd + uAxis * t;
  return vec3(horiz.x, up, horiz.y);
}

vec3 colonyWarpNormal(vec3 n, vec3 p) {
  vec3 pc = vec3(p.x - uCarLocal.x, p.y - uCarElev, p.z - uCarLocal.y);
  float s = dot(pc.xz, uForward);
  float theta = (s / uColonyR) * uColonyMix;
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
export function applyColony(
  material: THREE.Material,
  u: ColonyUniforms,
  nearFade = false,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uColonyR = u.uColonyR;
    shader.uniforms.uForward = u.uForward;
    shader.uniforms.uAxis = u.uAxis;
    shader.uniforms.uColonyMix = u.uColonyMix;
    shader.uniforms.uCarLocal = u.uCarLocal;
    shader.uniforms.uCarElev = u.uCarElev;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\n${GLSL_WARP}\nvarying float vCarDist;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>\n  objectNormal = colonyWarpNormal(objectNormal, position.xyz);`,
      )
      .replace(
        "#include <begin_vertex>",
        `vec3 transformed = colonyWarpPos(position.xyz);\n  vCarDist = length(position.xz - uCarLocal);`,
      );

    if (nearFade) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vCarDist;",
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>\n  {\n    float f = smoothstep(22.0, 70.0, vCarDist);\n    if (f <= 0.001) discard;\n    gl_FragColor.a *= f;\n  }`,
        );
      material.transparent = true;
      material.depthWrite = true;
    }
  };
  material.needsUpdate = true;
}

/** ローカル(東,北,標高) を CPU 側でビュー空間へ変換 (ピン等の非シェーダ要素用) */
export function colonyWarpCPU(
  x: number,
  y: number,
  z: number,
  u: ColonyUniforms
): THREE.Vector3 {
  const pcx = x - u.uCarLocal.value.x;
  const pcy = y - u.uCarElev.value;
  const pcz = z - u.uCarLocal.value.y;
  const f = u.uForward.value;
  const a = u.uAxis.value;
  const s = pcx * f.x + pcz * f.y;
  const t = pcx * a.x + pcz * a.y;
  const theta = (s / u.uColonyR.value) * u.uColonyMix.value;
  const radial = u.uColonyR.value - pcy;
  const fwd = radial * Math.sin(theta);
  const up = u.uColonyR.value - radial * Math.cos(theta);
  return new THREE.Vector3(
    f.x * fwd + a.x * t,
    up,
    f.y * fwd + a.y * t
  );
}
