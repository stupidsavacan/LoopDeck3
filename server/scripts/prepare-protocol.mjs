import {build} from 'esbuild';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),target=fileURLToPath(new URL('../generated/',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let canonical=false;
try{const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));await access(resolve(root,'src/packs/zipImporter.ts'));canonical=pkg.name==='loopdeck3';}catch{}
if(!canonical){const manifest=JSON.parse(await readFile(resolve(target,'protocol.json'),'utf8'));if(hash(await readFile(resolve(target,'pack-protocol.mjs')))!==manifest.bundleSha256)throw new Error('Shared protocol bundle checksum mismatch. Rebuild from the LoopDeck3 repository.');console.log('Verified versioned Pack protocol bundle (standalone Sites checkout).');process.exit(0);}
await mkdir(target,{recursive:true});
const result=await build({absWorkingDir:root,stdin:{contents:"export {contentFingerprint,sha256} from './src/packs/contentFingerprint'; export {importLoopDeckZip} from './src/packs/zipImporter';",resolveDir:root,sourcefile:'cloud-protocol-entry.ts',loader:'ts'},outfile:resolve(target,'pack-protocol.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',metafile:true,sourcemap:'external',sourcesContent:true,legalComments:'eof'});
// Normalize only EOF license comments; leave executable code and source-map lines intact.
const bundlePath=resolve(target,'pack-protocol.mjs');
await writeFile(bundlePath,(await readFile(bundlePath,'utf8')).replace(/\/\*![\s\S]*?\*\//g,comment=>comment.replace(/[\t ]+$/gm,'')));
const sources={};for(const path of Object.keys(result.metafile.inputs).filter(p=>p.startsWith('src/')).sort())sources[path]=hash(await readFile(resolve(root,path)));
await writeFile(resolve(target,'protocol.json'),JSON.stringify({description:'Generated from canonical LoopDeck3 sources; do not edit the bundle by hand.',bundleSha256:hash(await readFile(resolve(target,'pack-protocol.mjs'))),sources},null,2)+'\n');
await writeFile(resolve(target,'JSZIP_LICENSE.txt'),await readFile(resolve(root,'node_modules/jszip/LICENSE.markdown')));
await writeFile(resolve(target,'pack-protocol.d.mts'),`export interface ValidatedPack {packId:string;title:string;questions:unknown[];}
export interface PackResult {ok:boolean;pack?:ValidatedPack;assets?:unknown[];}
export function importLoopDeckZip(file:File,strictIntegrity?:boolean):Promise<PackResult>;
export function contentFingerprint(pack:ValidatedPack,assets:unknown[]):Promise<string>;
export function sha256(bytes:ArrayBuffer):Promise<string>;
`);
console.log('Prepared canonical Pack protocol:',Object.keys(sources).length,'source files.');
