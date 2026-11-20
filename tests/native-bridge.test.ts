/**
 * Native wrapper (Android APK) integration tests.
 *
 * The APK injects a `StepwiseNative` JavaScript interface into the WebView.
 * These tests assert that the game notices it, uses it for haptics, and
 * keeps the browser-only code paths working when it is absent.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Window } from 'happy-dom';

type PlatformModule = typeof import('../src/core/platform');

describe('Native platform bridge', () => {
  let win: Window;
  let originalWindow: unknown;

  beforeEach(() => {
    vi.resetModules();
    win = new Window({ url: 'https://example.test' });
    originalWindow = (globalThis as unknown as { window?: unknown }).window;
  });

  afterEach(() => {
    (globalThis as unknown as { window?: unknown }).window = originalWindow;
    win.close();
  });

  /** Installs the window global and loads the platform module against it. */
  async function loadPlatform(bridge?: unknown): Promise<PlatformModule> {
    (globalThis as unknown as { window?: unknown }).window = win;
    if (bridge !== undefined) {
      (win as unknown as { StepwiseNative: unknown }).StepwiseNative = bridge;
    }
    return import('../src/core/platform');
  }

  it('reports no native bridge in a plain browser', async () => {
    const platform = await loadPlatform();
    expect(platform.nativeBridge()).toBeUndefined();
    expect(platform.isNativeWrapper()).toBe(false);
  });

  it('detects the bridge the Android WebView injects', async () => {
    const platform = await loadPlatform({
      vibrate: () => undefined,
      isNative: () => true,
      platform: () => 'android',
      getTargetFps: () => 60,
    });

    expect(platform.nativeBridge()).toBeDefined();
    expect(platform.isNativeWrapper()).toBe(true);
    expect(platform.recommendedFrameRate()).toBe(60);
  });

  it('routes haptics through the native vibrator when present', async () => {
    const pulses: number[] = [];
    const platform = await loadPlatform({
      vibrate: (ms: number) => pulses.push(ms),
      isNative: () => true,
      platform: () => 'android',
      getTargetFps: () => 60,
    });

    expect(platform.vibrate(25)).toBe(true);
    expect(pulses).toEqual([25]);
  });

  it('clamps haptic pulses into a sane range', async () => {
    const pulses: number[] = [];
    const platform = await loadPlatform({
      vibrate: (ms: number) => pulses.push(ms),
      isNative: () => true,
      platform: () => 'android',
      getTargetFps: () => 60,
    });

    platform.vibrate(-100);
    platform.vibrate(9999);
    expect(pulses).toEqual([1, 400]);
  });

  it('ignores a partially injected bridge instead of throwing', async () => {
    const platform = await loadPlatform({});

    expect(platform.nativeBridge()).toBeUndefined();
    expect(platform.isNativeWrapper()).toBe(false);
  });

  it('survives a bridge that throws when called', async () => {
    const platform = await loadPlatform({
      vibrate: () => {
        throw new Error('no vibrator');
      },
      isNative: () => {
        throw new Error('boom');
      },
      platform: () => 'android',
      getTargetFps: () => {
        throw new Error('boom');
      },
    });

    expect(() => platform.vibrate(20)).not.toThrow();
    expect(platform.isNativeWrapper()).toBe(false);
    expect(platform.recommendedFrameRate()).toBe(60);
  });

  it('falls back to the web Vibration API without a native bridge', async () => {
    const platform = await loadPlatform();

    const webPulses: number[] = [];
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { vibrate: (ms: number) => webPulses.push(ms) },
      configurable: true,
      writable: true,
    });

    try {
      expect(platform.vibrate(18)).toBe(true);
      expect(webPulses).toEqual([18]);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });
});
