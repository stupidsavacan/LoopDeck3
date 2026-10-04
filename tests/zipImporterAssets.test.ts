import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { importLoopDeckJson, importLoopDeckZip } from '../src/packs/zipImporter';

function manifest() {
  return { packVersion: 1, packId: 'image-pack', title: 'Image Pack', folders: [{ id: 'f', title: 'Folder' }] };
}

function modules(questionIds: string[]) {
  return [{ id: 'm', folderId: 'f', title: 'Module', subject: 'demo', questionIds }];
}

function question(id: string, imageAsset?: string) {
  return { id, moduleId: 'm', type: 'input', prompt: `${id}?`, answer: id, imageAsset };
}

async function zipFile(questions: ReturnType<typeof question>[], images: Record<string, string> = {}): Promise<File> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest()));
  zip.file('modules.json', JSON.stringify(modules(questions.map((item) => item.id))));
  zip.file('questions.json', JSON.stringify(questions));
  for (const [path, base64] of Object.entries(images)) zip.file(path, base64, { base64: true });
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([bytes], 'image-pack.loopdeck.zip', { type: 'application/zip' });
}

describe('ZIP image asset import', () => {
  it('imports referenced PNG assets and ignores unreferenced images', async () => {
    const result = await importLoopDeckZip(
      await zipFile([question('q1', 'images/map.png')], {
        'images/map.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'images/unused.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      })
    );

    expect(result.ok).toBe(true);
    expect(result.assets).toHaveLength(1);
    expect(result.assets?.[0]).toMatchObject({ packId: 'image-pack', path: 'images/map.png', mimeType: 'image/png' });
    expect(result.assets?.[0]?.dataUrl).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    );
  });

  it('warns when a referenced image is missing', async () => {
    const result = await importLoopDeckZip(await zipFile([question('q1', 'images/missing.png')]));
    expect(result.ok).toBe(true);
    expect(result.assets).toEqual([]);
    expect(result.issues.some((issue) => issue.level === 'warning' && issue.path === 'images/missing.png')).toBe(true);
  });

  it('rejects unsafe image references before persistence', async () => {
    const result = await importLoopDeckZip(await zipFile([question('q1', '../evil.png')]));
    expect(result.ok).toBe(false);
    expect(result.assets).toBeUndefined();
    expect(result.issues.some((issue) => issue.level === 'error' && issue.path === '../evil.png')).toBe(true);
  });

  it('returns assets explicitly without hidden staging state', async () => {
    const result = await importLoopDeckZip(
      await zipFile([question('q1', 'images/map.png')], {
        'images/map.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      })
    );
    expect(result.assets).toHaveLength(1);
    expect(result.assets?.[0]).toMatchObject({ packId: 'image-pack', path: 'images/map.png' });
  });

  it('keeps JSON imports compatible and returns no assets', async () => {
    const pack = { ...manifest(), modules: modules(['q1']), questions: [question('q1')] };
    const result = await importLoopDeckJson(new File([JSON.stringify(pack)], 'image-pack.loopdeck.json'));
    expect(result.ok).toBe(true);
    expect(result.assets).toEqual([]);
  });
});
