import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isSafeImageDataUrl } from '../src/packs/assetSafety';

// Real 2x2 RGB frames encoded by Pillow/libwebp, not synthetic RIFF headers.
const animated =
  'UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAABkAAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA';
const still = 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';

describe('WebP structural compatibility', () => {
  it.each([
    ['baseline.jpg', 'image/jpeg'],
    ['progressive.jpg', 'image/jpeg'],
    ['pixel.png', 'image/png'],
    ['lossless.webp', 'image/webp']
  ])('accepts the actual encoded image fixture %s', (filename, mime) => {
    const bytes = readFileSync(new URL(`./fixtures/imageContainers/${filename}`, import.meta.url));
    expect(isSafeImageDataUrl(`data:${mime};base64,${bytes.toString('base64')}`)).toBe(true);
  });

  it.each([still, animated])('accepts valid still and animated WebP', (payload) => {
    expect(isSafeImageDataUrl(`data:image/webp;base64,${payload}`)).toBe(true);
  });

  it('rejects a truncated animation frame even when the RIFF size is adjusted', () => {
    const bytes = Buffer.from(animated, 'base64').subarray(0, 190);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    expect(isSafeImageDataUrl(`data:image/webp;base64,${bytes.toString('base64')}`)).toBe(false);
  });

  it('rejects an animation frame with no bitstream subchunk', () => {
    const bytes = Buffer.from(animated, 'base64');
    // First ANMF contains a VP8 subchunk at byte 68.
    bytes.write('JUNK', 68, 'ascii');
    expect(isSafeImageDataUrl(`data:image/webp;base64,${bytes.toString('base64')}`)).toBe(false);
  });
});
