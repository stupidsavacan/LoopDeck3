import { createHash } from 'node:crypto';
import JSZip from 'jszip';

/** Offline check: the supplied APK embeds the exact single HTML build. */
export async function verifyArtifacts(apk: Buffer, html: Buffer) {
  const zip = await JSZip.loadAsync(apk, { checkCRC32: true });
  const entry = zip.file('assets/loopdeck/index.html');
  if (!entry) throw new Error('APK is missing assets/loopdeck/index.html');
  const embedded = await entry.async('nodebuffer');
  if (embedded.length > 100 * 1024 * 1024) throw new Error('APK HTML exceeds the evidence size limit');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return {
    matches: embedded.equals(html),
    apkSha256: digest(apk),
    htmlSha256: digest(html),
    embeddedHtmlSha256: digest(embedded),
    htmlBytes: html.length,
    embeddedHtmlBytes: embedded.length
  };
}
