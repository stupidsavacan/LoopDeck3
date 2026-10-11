import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { verifyArtifacts } from '../tools/device/artifacts';

describe('Android build artifact identity', () => {
  it('checks bytes and hashes of the packaged HTML rather than only its name', async () => {
    const html = Buffer.from('<!doctype html><p>学習</p>');
    const zip = new JSZip().file('assets/loopdeck/index.html', html);
    const apk = await zip.generateAsync({ type: 'nodebuffer' });
    expect(await verifyArtifacts(apk, html)).toMatchObject({ matches: true, htmlBytes: html.length });
    const changed = await verifyArtifacts(apk, Buffer.from('<!doctype html><p>other build</p>'));
    expect(changed.matches).toBe(false);
    expect(changed.embeddedHtmlSha256).not.toBe(changed.htmlSha256);
  });

  it('rejects an APK without the required HTML and a malformed ZIP', async () => {
    const apk = await new JSZip().file('other', 'x').generateAsync({ type: 'nodebuffer' });
    await expect(verifyArtifacts(apk, Buffer.from('x'))).rejects.toThrow('missing');
    await expect(verifyArtifacts(Buffer.from('not a ZIP'), Buffer.from('x'))).rejects.toThrow();
  });
});
