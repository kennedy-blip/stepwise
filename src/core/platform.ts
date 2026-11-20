/**
 * Native platform bridge.
 *
 * The Android APK (see `android/` in this repository) wraps the game in a
 * full-screen WebView and injects a `StepwiseNative` JavaScript interface.
 * It exposes:
 *
 *   `vibrate(durationMs)` — fires the device vibrator
 *   `isNative()`         — true inside the APK
 *   `platform()`         — "android"
 *   `getTargetFps()`     — the frame-rate target the wrapper recommends
 *
 * Everything degrades gracefully: in a plain browser the bridge is absent and
 * the helpers fall back to the web equivalents (the Vibration API and the
 * device's own refresh rate).
 */

/** Shape of the object the Android WebView injects as `window.StepwiseNative`. */
export interface StepwiseNativeBridge {
  vibrate(durationMs: number): void;
  isNative(): boolean;
  platform(): string;
  getTargetFps(): number;
}

declare global {
  interface Window {
    StepwiseNative?: StepwiseNativeBridge;
  }
}

/** The injected bridge, when the game runs inside the Android APK. */
export function nativeBridge(): StepwiseNativeBridge | undefined {
  const scope = globalScope();
  if (!scope) return undefined;
  const bridge = (scope as { StepwiseNative?: StepwiseNativeBridge }).StepwiseNative;
  // The WebView injects the object but only exposes its methods on Android
  // API 17+; guard so a partially-injected object cannot throw.
  if (!bridge || typeof bridge.vibrate !== 'function') return undefined;
  return bridge;
}

/** The global window object, when the code is running in a browser. */
function globalScope(): (Window & typeof globalThis) | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

/** True when the game is running inside the native Android wrapper. */
export function isNativeWrapper(): boolean {
  const bridge = nativeBridge();
  if (bridge && typeof bridge.isNative === 'function') {
    try {
      if (bridge.isNative()) return true;
    } catch {
      /* fall through to the other checks */
    }
  }
  // A Capacitor/Bubblewrap wrapper injects its own global flag.
  const scope = globalScope();
  if (!scope) return false;
  const w = scope as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  try {
    if (w.Capacitor?.isNativePlatform?.()) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Fire a haptic pulse.
 *
 * Uses the native vibrator inside the APK and the web Vibration API
 * elsewhere. Returns true when a pulse was actually requested.
 */
export function vibrate(durationMs: number): boolean {
  const duration = Math.max(1, Math.min(400, Math.round(durationMs)));

  const bridge = nativeBridge();
  if (bridge) {
    try {
      bridge.vibrate(duration);
      return true;
    } catch {
      /* fall through to the web API */
    }
  }

  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (nav && typeof nav.vibrate === 'function') {
    try {
      nav.vibrate(duration);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The frame-rate target the current platform recommends.
 *
 * The APK suggests 60 Hz to keep the WebView within its thermal budget;
 * elsewhere the display's own refresh rate is used.
 */
export function recommendedFrameRate(): number {
  const bridge = nativeBridge();
  if (bridge && typeof bridge.getTargetFps === 'function') {
    try {
      const fps = bridge.getTargetFps();
      if (typeof fps === 'number' && fps > 0) return fps;
    } catch {
      /* ignore */
    }
  }
  return 60;
}
