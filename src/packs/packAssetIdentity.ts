export function packAssetId(packId: string, path: string): string {
  return JSON.stringify([packId, path]);
}
