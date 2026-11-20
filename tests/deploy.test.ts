/**
 * Deployment configuration tests.
 *
 * The Vercel config and the download route are part of the shipped product,
 * so they are asserted here rather than being left to a manual check after
 * a deploy. Both of the bugs below shipped to production once.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { APK_AVAILABLE, APK_DOWNLOAD_URL } from '../src/game/config';

interface VercelConfig {
  buildCommand?: string;
  outputDirectory?: string;
  framework?: string;
  cleanUrls?: boolean;
  headers?: { source: string; headers: { key: string; value: string }[] }[];
  rewrites?: { source: string; destination: string }[];
}

describe('Deployment configuration', () => {
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf-8')) as VercelConfig;

  it('builds the Vite bundle into dist', () => {
    expect(vercel.framework).toBe('vite');
    expect(vercel.outputDirectory).toBe('dist');
    expect(vercel.buildCommand).toBe('npm run build');
  });

  it('has no self-referencing rewrite', () => {
    // A rewrite whose source and destination are identical is an infinite
    // loop: Vercel never reaches the filesystem, so the route 404s. This
    // shipped once and broke the APK download.
    for (const rewrite of vercel.rewrites ?? []) {
      expect(rewrite.destination).not.toBe(rewrite.source);
    }
  });

  it('routes the APK download at a file that actually exists', () => {
    const rewrite = (vercel.rewrites ?? []).find((r) => r.source === APK_DOWNLOAD_URL);
    expect(rewrite).toBeDefined();

    // The destination must be present in the published public folder.
    const destination = rewrite!.destination.replace(/^\//, '');
    expect(existsSync(`public/${destination}`)).toBe(true);
  });

  it('only labels a real APK with the Android package content type', () => {
    // The placeholder is a text file. Serving it with the APK content type
    // makes the browser try to install text as an app.
    const apkHeader = (vercel.headers ?? []).find((h) => h.source.includes('.apk'));
    expect(apkHeader).toBeDefined();
    const contentType = apkHeader!.headers.find((h) => h.key.toLowerCase() === 'content-type');
    expect(contentType?.value).toBe('application/vnd.android.package-archive');
  });

  it('ships a placeholder APK only while no real binary exists', () => {
    const placeholder = existsSync('public/downloads/stepwise.apk.txt');
    const real = existsSync('public/downloads/stepwise.apk');

    if (real) {
      expect(APK_AVAILABLE).toBe(true);
    } else {
      // Without a binary the UI must not promise a working install.
      expect(APK_AVAILABLE).toBe(false);
      expect(placeholder).toBe(true);
    }
  });

  it('serves a favicon so the browser does not 404 on /favicon.ico', () => {
    // The browser requests /favicon.ico by default. Without an explicit
    // icon the deployment logged a 404 on every page load.
    const html = readFileSync('index.html', 'utf-8');
    expect(html).toMatch(/<link[^>]+rel=["']icon["']/);
    expect(existsSync('public/favicon.svg')).toBe(true);
  });

  it('applies the security headers to every response', () => {
    const global = (vercel.headers ?? []).find((h) => h.source === '/(.*)');
    expect(global).toBeDefined();
    const keys = global!.headers.map((h) => h.key.toLowerCase());
    expect(keys).toContain('x-content-type-options');
    expect(keys).toContain('x-frame-options');
    expect(keys).toContain('referrer-policy');
    expect(keys).toContain('permissions-policy');
  });
});
