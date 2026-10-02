import { readFile, writeFile, readdir } from 'node:fs/promises';
import { extname, dirname, join, relative, resolve, sep } from 'node:path';

const distDir = resolve(process.cwd(), process.argv[2] ?? 'dist-single');
const outputPath = resolve(process.cwd(), process.argv[3] ?? 'LoopDeck3.html');
const indexPath = join(distDir, 'index.html');

const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.cjs', '.json', '.svg', '.txt', '.xml']);
const runtimeSharedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const mimeTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

const slash = (value) => value.split(sep).join('/');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function dataUriFor(path, buffer) {
  const ext = extname(path).toLowerCase();
  const mime = mimeTypes[ext] || 'application/octet-stream';
  return 'data:' + mime + ';base64,' + buffer.toString('base64');
}

function replaceAllLiteral(source, needle, replacement) {
  if (!needle || !source.includes(needle)) return source;
  return source.replace(new RegExp(escapeRegExp(needle), 'g'), () => replacement);
}

async function embedBinaryReferences(files) {
  const textFiles = files.filter((path) => textExtensions.has(extname(path).toLowerCase()));
  const binaryFiles = files.filter((path) => !textExtensions.has(extname(path).toLowerCase()));

  const textContents = new Map();
  const sharedRuntimeAssets = {};
  for (const path of textFiles) textContents.set(path, await readFile(path, 'utf8'));

  for (const binaryPath of binaryFiles) {
    const dataUri = dataUriFor(binaryPath, await readFile(binaryPath));
    const rootRelative = slash(relative(distDir, binaryPath));
    const isRuntimeSharedImage =
      rootRelative.startsWith('images/') &&
      runtimeSharedImageExtensions.has(extname(binaryPath).toLowerCase());

    if (isRuntimeSharedImage) sharedRuntimeAssets[rootRelative] = dataUri;

    for (const textPath of textFiles) {
      let content = textContents.get(textPath);
      const textExt = extname(textPath).toLowerCase();

      // Question.imageAsset must stay a path inside bundled JavaScript/JSON.
      // The single-file runtime resolves that path through sharedRuntimeAssets,
      // so one image payload is stored once instead of once per question.
      if (isRuntimeSharedImage && ['.js', '.mjs', '.cjs', '.json'].includes(textExt)) continue;

      const relativeFromText = slash(relative(dirname(textPath), binaryPath));
      const candidates = new Set([
        rootRelative,
        './' + rootRelative,
        '/' + rootRelative,
        relativeFromText,
        relativeFromText.startsWith('.') ? relativeFromText : './' + relativeFromText
      ]);

      for (const candidate of candidates) content = replaceAllLiteral(content, candidate, dataUri);
      textContents.set(textPath, content);
    }
  }

  for (const [path, content] of textContents) await writeFile(path, content, 'utf8');
  return sharedRuntimeAssets;
}

function resolveHtmlAsset(ref) {
  const clean = ref.split(/[?#]/, 1)[0].replace(/^\.\//, '').replace(/^\//, '');
  return join(distDir, clean);
}

async function replaceAsync(input, regex, replacer) {
  const matches = [...input.matchAll(regex)];
  let output = input;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const replacement = await replacer(...match);
    output = output.slice(0, match.index) + replacement + output.slice(match.index + match[0].length);
  }
  return output;
}

async function inlineHtmlAssets() {
  const files = await walk(distDir);
  const sharedRuntimeAssets = await embedBinaryReferences(files);

  const jsFiles = files.filter((path) => ['.js', '.mjs'].includes(extname(path).toLowerCase()));
  if (jsFiles.length !== 1) {
    throw new Error(
      'Single-HTML build expected exactly one JavaScript bundle, found ' +
      jsFiles.length +
      ': ' +
      jsFiles.map((path) => slash(relative(distDir, path))).join(', ')
    );
  }

  let html = await readFile(indexPath, 'utf8');

  if (Object.keys(sharedRuntimeAssets).length) {
    const serializedAssets = JSON.stringify(sharedRuntimeAssets).replace(/</g, '\\u003c');
    const assetScript =
      '<script>globalThis.__LOOPDECK_EMBEDDED_ASSETS__ = Object.freeze(' +
      serializedAssets +
      ');</script>';
    html = html.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + assetScript);
  }

  html = html.replace(
    /<link\b(?=[^>]*\brel=["']modulepreload["'])[^>]*>/gi,
    ''
  );

  html = await replaceAsync(
    html,
    /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    async (_full, href) => {
      const css = await readFile(resolveHtmlAsset(href), 'utf8');
      return '<style>\n' + css + '\n</style>';
    }
  );

  html = await replaceAsync(
    html,
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    async (_full, before, src, after) => {
      const js = await readFile(resolveHtmlAsset(src), 'utf8');
      const attrs = (before + ' ' + after)
        .replace(/\bcrossorigin(?:=["'][^"']*["'])?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      return '<script' + (attrs ? ' ' + attrs : '') + '>\n' + js + '\n</script>';
    }
  );

  const localRef = html.match(
    /<(?:script|link|img|source)\b[^>]*(?:src|href)=["'](?!data:|https?:|#|mailto:|tel:)([^"']+)["']/i
  );
  if (localRef) {
    throw new Error('Single HTML still contains a local resource reference: ' + localRef[1]);
  }

  for (const [assetPath, dataUri] of Object.entries(sharedRuntimeAssets)) {
    const payloadCount = html.split(dataUri).length - 1;
    if (payloadCount !== 1) {
      throw new Error(
        'Shared runtime asset payload must appear exactly once: ' +
        assetPath +
        ' appeared ' +
        payloadCount +
        ' times'
      );
    }
  }

  await writeFile(outputPath, html, 'utf8');
  console.log(
    'Created ' +
    slash(relative(process.cwd(), outputPath)) +
    ' (' +
    Buffer.byteLength(html).toLocaleString() +
    ' bytes)'
  );
}

await inlineHtmlAssets();
