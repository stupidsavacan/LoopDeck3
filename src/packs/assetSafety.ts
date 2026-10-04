import { ALLOWED_IMAGE_EXTENSIONS } from './packTypes';
import { estimateBase64DecodedBytes, MAX_IMAGE_ASSET_BYTES } from './importLimits';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i;

export function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0].toLowerCase();
  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const dot = clean.lastIndexOf('.');
  return dot > lastSlash ? clean.slice(dot) : '';
}

export function isSafePackPath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed !== path) return false;
  if (!trimmed || trimmed.includes('\0')) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || WINDOWS_ABSOLUTE_PATH.test(trimmed)) return false;
  if (URI_SCHEME.test(trimmed)) return false;

  const segments = trimmed.replace(/\\/g, '/').split('/');
  return segments.every((segment) => segment !== '' && segment !== '..');
}

export function isSafeImageAssetRef(ref: string): boolean {
  return isSafePackPath(ref) && ALLOWED_IMAGE_EXTENSIONS.includes(extensionOf(ref));
}

export function isSafeImageDataUrl(value: string): boolean {
  if (!SAFE_IMAGE_DATA_URL.test(value)) return false;
  if (estimateBase64DecodedBytes(value) > MAX_IMAGE_ASSET_BYTES) return false;
  const comma = value.indexOf(',');
  const payload = value.slice(comma + 1);
  try {
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    return hasImageStructure(bytes, value.slice(5, value.indexOf(';')).toLowerCase());
  } catch {
    return false;
  }
}

/** Validate container structure without executing or trusting the filename. */
function hasImageStructure(bytes: Uint8Array, mime: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (mime === 'image/png') {
    if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return false;
    if (view.getUint32(8) !== 13 || tag(12) !== 'IHDR' || view.getUint32(16) === 0 || view.getUint32(20) === 0) return false;
    let hasData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return false;
      const type = tag(offset + 4);
      if (type === 'IDAT' && length > 0) hasData = true;
      if (type === 'IEND') return length === 0 && end === bytes.length && hasData;
      offset = end;
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 26 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return false;
    return hasWebPImageChunks(bytes, 12, bytes.length, true);
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
    let hasFrame = false;
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda) return hasFrame && view.getUint16(offset) >= 6 && offset + view.getUint16(offset) < bytes.length - 2;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      // SOF0..SOF15 cover sequential/progressive/lossless and Huffman/arithmetic
      // frames; DHT, JPG and DAC occupy the other codes in this range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8)
        hasFrame = view.getUint16(offset + 3) > 0 && view.getUint16(offset + 5) > 0;
      offset += length;
    }
  }
  return false;
}

function hasWebPImageChunks(bytes: Uint8Array, start: number, limit: number, allowAnimation: boolean): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hasImage = false;
  let offset = start;
  while (offset + 8 <= limit) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const payloadEnd = offset + 8 + length;
    const end = payloadEnd + (length % 2);
    if (end > limit) return false;
    if (type === 'VP8 ' && length >= 10) hasImage = true;
    if (type === 'VP8L' && length >= 5 && bytes[offset + 8] === 0x2f) hasImage = true;
    if (type === 'ANMF') {
      // A frame has a 16-byte header followed by ALPH/VP8/VP8L subchunks.
      if (!allowAnimation || length < 16 || !hasWebPImageChunks(bytes, offset + 24, payloadEnd, false)) return false;
      hasImage = true;
    }
    offset = end;
  }
  return offset === limit && hasImage;
}
