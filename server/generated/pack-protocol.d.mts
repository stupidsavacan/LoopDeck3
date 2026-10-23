export interface ValidatedPack {packId:string;title:string;questions:unknown[];}
export interface PackResult {ok:boolean;pack?:ValidatedPack;assets?:unknown[];}
export function importLoopDeckZip(file:File,strictIntegrity?:boolean):Promise<PackResult>;
export function contentFingerprint(pack:ValidatedPack,assets:unknown[]):Promise<string>;
export function sha256(bytes:ArrayBuffer):Promise<string>;
