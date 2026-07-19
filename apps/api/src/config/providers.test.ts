import { describe, expect, test } from 'bun:test';
import {
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
} from '@coji/shared/providers';
import { createProviders } from './providers.ts';

// env defaults to the fakes (IMAGE/ANIMATION/RENDER=noop, STORAGE=local-fs),
// which is the CI default — so the factory must never produce a paid provider.
describe('provider factory', () => {
  test('resolves all four seams to deterministic fakes by default', () => {
    const providers = createProviders();
    expect(providers.image).toBeInstanceOf(NoopImageProvider);
    expect(providers.animation).toBeInstanceOf(NoopAnimationProvider);
    expect(providers.render).toBeInstanceOf(NoopRenderProvider);
    expect(providers.storage).toBeInstanceOf(LocalFilesystemStorageProvider);
  });

  test('the resolved bundle drives a put → signed-url round trip', async () => {
    const { storage } = createProviders();
    await storage.put('factory/probe', new TextEncoder().encode('ok'), 'text/plain');
    const url = await storage.getSignedUrl('factory/probe', 60);
    expect(url).toContain('factory%2Fprobe');
  });
});
