import type JSZip from 'jszip';
interface EntryStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'end', callback: () => void): void;
  pause(): void;
  resume(): void;
}
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** Sequential streams avoid JSZip's parallel checkCRC32 expansion of all entries. */
export async function verifyZipIntegrity(zip: JSZip, buffer: ArrayBuffer, sizes: Map<string, number>): Promise<void> {
  const view = new DataView(buffer),
    expected = new Map<string, number>();
  let end = buffer.byteLength - 22;
  while (end >= Math.max(0, buffer.byteLength - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Invalid ZIP directory.');
  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let i = 0; i < count; i++) {
    const length = view.getUint16(offset + 28, true),
      path = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, length)).replace(/\\/g, '/');
    if (expected.has(path)) throw new Error('Duplicate ZIP path.');
    expected.set(path, view.getUint32(offset + 16, true));
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  for (const [path, crc] of expected) {
    const entry = zip.files[path];
    if (!entry) throw new Error('ZIP path mismatch.');
    if (entry.dir) continue;
    await new Promise<void>((resolve, reject) => {
      let bytes = 0,
        value = 0xffffffff;
      const stream = (entry as typeof entry & { internalStream(type: 'uint8array'): EntryStream }).internalStream('uint8array');
      stream.on('data', (chunk: Uint8Array) => {
        bytes += chunk.length;
        if (bytes > (sizes.get(path) ?? 0)) {
          stream.pause();
          reject(new Error('ZIP expanded size mismatch.'));
          return;
        }
        for (const b of chunk) value = table[(value ^ b) & 255] ^ (value >>> 8);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        if (bytes !== sizes.get(path) || (value ^ 0xffffffff) >>> 0 !== crc) reject(new Error('ZIP CRC mismatch.'));
        else resolve();
      });
      stream.resume();
    });
  }
}
