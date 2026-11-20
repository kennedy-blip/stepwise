/**
 * Atmospheric lighting moods for the 3D scene.
 *
 * Three presets are defined, matching the game's existing sky moods:
 *  - Golden Dusk   : low warm sun, cool twilight fill, dusk haze.
 *  - Neon Rain     : night, cool moon key, wet glossy roofs, neon bounce.
 *  - Misty Dawn    : crisp silver-teal morning, soft shadows, dense fog.
 *
 * Each preset owns its own directional key light, hemisphere fill, rim
 * light, fog colour/density and background gradient. Switching mood swaps the
 * values in place so the scene graph never has to be rebuilt.
 */

import * as THREE from 'three';
import type { SkyMood } from '../core/types';

export interface LightingPreset {
  /** Sky gradient, top to bottom. */
  skyTop: string;
  skyMid: string;
  skyBottom: string;
  /** Directional key light colour and intensity. */
  sunColor: string;
  sunIntensity: number;
  /** Direction the key light travels from, in degrees. */
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  /** Hemisphere fill: sky and ground colours. */
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  /** Rim light colour and intensity. */
  rimColor: string;
  rimIntensity: number;
  /** Exponential fog colour and density. */
  fogColor: string;
  fogDensity: number;
  /** Ambient accent bounce colours (neon signs, city glow). */
  bounceA: string;
  bounceB: string;
  /** Base rooftop surface tint and roughness. */
  roofTint: string;
  roofRoughness: number;
  /** Tint of the building face below each rooftop. */
  facadeTint: string;
  /** Emissive window colour for the background city. */
  windowColor: string;
  /** How many background windows are lit (0..1). */
  windowDensity: number;
  /** Weather particle mode. */
  weather: 'rain' | 'dust' | 'none';
  /** Bloom strength for the high preset. */
  bloomStrength: number;
  /** Bloom threshold. */
  bloomThreshold: number;
  /**
   * How visible the sun/moon disc in the sky is (0 hides it entirely).
   */
  sunDisc: number;
  /** How dense the low-lying street haze is. */
  hazeOpacity: number;
}

export const LIGHTING_PRESETS: Record<SkyMood, LightingPreset> = {
  dusk: {
    skyTop: '#171733',
    skyMid: '#7b3f6b',
    skyBottom: '#f0a05a',
    sunColor: '#ff9e5e',
    sunIntensity: 2.6,
    sunAzimuthDeg: -38,
    sunElevationDeg: 13,
    hemiSky: '#3b4d7a',
    hemiGround: '#1a1625',
    hemiIntensity: 0.72,
    rimColor: '#ffb45c',
    rimIntensity: 1.1,
    fogColor: '#2b2238',
    fogDensity: 0.0125,
    bounceA: '#ff8a4c',
    bounceB: '#5f7fd6',
    roofTint: '#3a3f4d',
    roofRoughness: 0.86,
    facadeTint: '#2b303c',
    windowColor: '#ffd28c',
    windowDensity: 0.42,
    weather: 'dust',
    bloomStrength: 0.42,
    bloomThreshold: 0.72,
    sunDisc: 1.0,
    hazeOpacity: 0.55,
  },
  rain: {
    skyTop: '#05060f',
    skyMid: '#0d1330',
    skyBottom: '#182048',
    sunColor: '#6ea8ff',
    sunIntensity: 1.35,
    sunAzimuthDeg: -22,
    sunElevationDeg: 34,
    hemiSky: '#16224a',
    hemiGround: '#070a14',
    hemiIntensity: 0.5,
    rimColor: '#5fe0ff',
    rimIntensity: 1.35,
    fogColor: '#0b1226',
    fogDensity: 0.019,
    bounceA: '#00f0ff',
    bounceB: '#ff2a85',
    roofTint: '#232b3a',
    roofRoughness: 0.22,
    facadeTint: '#1c2432',
    windowColor: '#9fe6ff',
    windowDensity: 0.3,
    weather: 'rain',
    bloomStrength: 0.78,
    bloomThreshold: 0.52,
    sunDisc: 0.0,
    hazeOpacity: 0.7,
  },
  dawn: {
    skyTop: '#243b52',
    skyMid: '#5d7f96',
    skyBottom: '#cfd9dc',
    sunColor: '#cfe6ec',
    sunIntensity: 2.05,
    sunAzimuthDeg: 28,
    sunElevationDeg: 26,
    hemiSky: '#a8c4d0',
    hemiGround: '#48555e',
    hemiIntensity: 1.0,
    rimColor: '#dff0f5',
    rimIntensity: 0.85,
    fogColor: '#8fa8b2',
    fogDensity: 0.023,
    bounceA: '#bcd8e0',
    bounceB: '#8fa8b2',
    roofTint: '#49535d',
    roofRoughness: 0.82,
    facadeTint: '#39414c',
    windowColor: '#ffe6bd',
    windowDensity: 0.2,
    weather: 'none',
    bloomStrength: 0.3,
    bloomThreshold: 0.8,
    sunDisc: 0.7,
    hazeOpacity: 0.85,
  },
};

/**
 * Owns the scene's light rig and sky dome, and swaps between presets.
 */
export class LightingRig {
  /** The key (sun / moon) directional light. */
  readonly sun: THREE.DirectionalLight;
  /** Hemisphere sky/ground fill. */
  readonly hemisphere: THREE.HemisphereLight;
  /** Rim light that separates the runner from the background. */
  readonly rim: THREE.DirectionalLight;
  /** Two coloured bounce lights used for neon mood accents. */
  readonly bounceA: THREE.PointLight;
  readonly bounceB: THREE.PointLight;
  /** Sky dome mesh — a large inverted sphere with a vertical gradient. */
  readonly skyDome: THREE.Mesh;

  /** Low-lying haze in the street canyon below the rooftops. */
  readonly hazeNear: THREE.Mesh;
  /** A deeper, softer haze layer further back. */
  readonly hazeFar: THREE.Mesh;
  /** Scene fog. */
  readonly fog: THREE.FogExp2;

  /** The sky dome shader; its uniforms carry the sun disc and halo. */
  readonly skyMaterial: THREE.ShaderMaterial;
  /** The near street-canyon haze shader. */
  readonly hazeMaterial: THREE.ShaderMaterial;
  private current: SkyMood = 'dusk';

  constructor(scene: THREE.Scene) {
    this.sun = new THREE.DirectionalLight('#ff9e5e', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 120;
    this.sun.shadow.camera.left = -30;
    this.sun.shadow.camera.right = 30;
    this.sun.shadow.camera.top = 24;
    this.sun.shadow.camera.bottom = -14;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.03;

    this.hemisphere = new THREE.HemisphereLight('#3b4d7a', '#1a1625', 0.72);
    this.rim = new THREE.DirectionalLight('#ffb45c', 1.1);
    this.bounceA = new THREE.PointLight('#ff8a4c', 0, 34, 2);
    this.bounceB = new THREE.PointLight('#5f7fd6', 0, 34, 2);

    this.fog = new THREE.FogExp2('#2b2238', 0.0125);
    scene.fog = this.fog;

    // Sky dome: an inverted sphere with a vertical gradient shader.
    this.skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color('#171733') },
        midColor: { value: new THREE.Color('#7b3f6b') },
        bottomColor: { value: new THREE.Color('#f0a05a') },
        // Direction the visible sun/moon disc sits at, and its colour.
        sunDirection: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color('#ff9e5e') },
        // 0 hides the disc (fully overcast, or the disc is behind us).
        sunDisc: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying float vHeight;
        varying vec3 vDir;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vDir = normalize(worldPos.xyz);
          vHeight = vDir.y;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform float sunDisc;
        varying float vHeight;
        varying vec3 vDir;
        void main() {
          float h = clamp(vHeight * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = h < 0.5
            ? mix(bottomColor, midColor, smoothstep(0.0, 0.5, h))
            : mix(midColor, topColor, smoothstep(0.5, 1.0, h));

          // The sun disc, with a wide atmospheric bloom around it. The
          // bloom is what sells the sky: a hard-edged disc on a flat
          // gradient looks like a sticker.
          if (sunDisc > 0.001) {
            float d = dot(normalize(vDir), normalize(sunDirection));
            // Tight core.
            float disc = smoothstep(0.9985, 0.9994, d);
            // Wide halo.
            float halo = pow(max(d, 0.0), 220.0) * 0.85
                       + pow(max(d, 0.0), 26.0) * 0.30
                       + pow(max(d, 0.0), 6.0) * 0.09;
            col += sunColor * (disc * 2.6 + halo) * sunDisc;
          }

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(190, 24, 16), this.skyMaterial);
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -1000;
    scene.add(this.skyDome);

    // --- Street haze ------------------------------------------------------
    // A soft band of haze sitting in the canyon below the rooftops. It is
    // what gives a city its sense of depth: the towers fade into it, and
    // the roofs read as being high above the street.
    this.hazeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        hazeColor: { value: new THREE.Color('#2b2238') },
        opacity: { value: 0.5 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 hazeColor;
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          // Dense at the bottom, gone by the top.
          float fade = pow(1.0 - clamp(vUv.y, 0.0, 1.0), 2.0);
          gl_FragColor = vec4(hazeColor, fade * opacity);
        }
      `,
    });

    // Two stacked planes at different depths read as a layered atmosphere
    // rather than a single flat card.
    // The near band sits just below the rooftops, so the towers behind it
    // fade out of sight as they descend. Its top edge must stay BELOW the
    // roof line, or it becomes a grey card across the sky.
    this.hazeNear = new THREE.Mesh(new THREE.PlaneGeometry(320, 18), this.hazeMaterial);
    this.hazeNear.position.set(0, -13, -14);
    this.hazeNear.renderOrder = -900;
    this.hazeNear.frustumCulled = false;
    scene.add(this.hazeNear);

    // The far band is lower and wider: the deep skyline fades into it.
    const farHazeMaterial = this.hazeMaterial.clone();
    farHazeMaterial.uniforms.opacity.value = 0.75;
    this.hazeFar = new THREE.Mesh(new THREE.PlaneGeometry(520, 30), farHazeMaterial);
    this.hazeFar.position.set(0, -19, -42);
    this.hazeFar.renderOrder = -901;
    this.hazeFar.frustumCulled = false;
    scene.add(this.hazeFar);

    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.hemisphere);
    scene.add(this.rim);
    scene.add(this.rim.target);
    scene.add(this.bounceA);
    scene.add(this.bounceB);

    this.apply('dusk');
  }

  /** The mood currently applied. */
  get mood(): SkyMood {
    return this.current;
  }

  /** Applies a lighting preset to the whole scene. */
  apply(mood: SkyMood): void {
    const p = LIGHTING_PRESETS[mood];
    this.current = mood;

    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;

    const az = THREE.MathUtils.degToRad(p.sunAzimuthDeg);
    const el = THREE.MathUtils.degToRad(p.sunElevationDeg);
    // The sun is positioned relative to the camera target, which is updated
    // each frame by `followSun`.
    this.sunOffset = new THREE.Vector3(
      Math.sin(az) * Math.cos(el) * 40,
      Math.sin(el) * 40 + 8,
      Math.cos(az) * Math.cos(el) * 40,
    );

    this.hemisphere.color.set(p.hemiSky);
    this.hemisphere.groundColor.set(p.hemiGround);
    this.hemisphere.intensity = p.hemiIntensity;

    this.rim.color.set(p.rimColor);
    this.rim.intensity = p.rimIntensity;

    this.bounceA.color.set(p.bounceA);
    this.bounceB.color.set(p.bounceB);
    // Neon bounce only matters at night; in daylight it would wash the scene.
    const neonBoost = mood === 'rain' ? 3.2 : 0;
    this.bounceA.intensity = neonBoost;
    this.bounceB.intensity = neonBoost;

    this.fog.color.set(p.fogColor);
    this.fog.density = p.fogDensity;

    this.skyMaterial.uniforms.topColor.value.set(p.skyTop);
    this.skyMaterial.uniforms.midColor.value.set(p.skyMid);
    this.skyMaterial.uniforms.bottomColor.value.set(p.skyBottom);
    this.skyMaterial.uniforms.sunColor.value.set(p.sunColor);
    // The visible disc sits along the key light's direction, so the sun in
    // the sky always matches where the shadows fall.
    this.skyMaterial.uniforms.sunDirection.value.copy(this.sunOffset).normalize();
    this.skyMaterial.uniforms.sunDisc.value = p.sunDisc;

    // The street haze takes the fog colour, so it always sits inside the
    // mood's palette instead of fighting it.
    this.hazeMaterial.uniforms.hazeColor.value.set(p.fogColor);
    this.hazeMaterial.uniforms.opacity.value = p.hazeOpacity;
    (this.hazeFar.material as THREE.ShaderMaterial).uniforms.hazeColor.value.set(p.fogColor);
    (this.hazeFar.material as THREE.ShaderMaterial).uniforms.opacity.value = p.hazeOpacity * 1.5;
  }

  /** Cached sun offset relative to the focus point. */
  private sunOffset = new THREE.Vector3(0, 40, 40);

  /**
   * Keeps the key light and its shadow camera centred on the runner so the
   * shadow frustum always covers the action.
   */
  followSun(focusX: number, focusY: number): void {
    this.sun.position.set(focusX + this.sunOffset.x, focusY + this.sunOffset.y, this.sunOffset.z);
    this.sun.target.position.set(focusX, focusY, 0);
    this.sun.target.updateMatrixWorld();

    // Rim light comes from the opposite side and slightly behind, which is
    // what separates the runner from the background.
    this.rim.position.set(focusX - this.sunOffset.x * 0.6, focusY + 6, -18);
    this.rim.target.position.set(focusX, focusY + 1, 0);
    this.rim.target.updateMatrixWorld();

    this.bounceA.position.set(focusX + 6, focusY + 3, -8);
    this.bounceB.position.set(focusX - 8, focusY + 2, -12);

    this.skyDome.position.set(focusX, focusY, 0);
    // The haze lives in world space, so it tracks the camera horizontally
    // but stays anchored to the street far below.
    this.hazeNear.position.x = focusX;
    this.hazeFar.position.x = focusX;
  }

  /** Resizes the shadow map for the given quality preset. */
  setShadowMapSize(size: number): void {
    if (this.sun.shadow.mapSize.width === size) return;
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
  }

  /** Disposes the light rig's GPU resources. */
  dispose(): void {
    this.skyDome.geometry.dispose();
    this.skyMaterial.dispose();
  }
}
