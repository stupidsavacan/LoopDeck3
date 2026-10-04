import { describe, expect, it } from 'vitest';
import { androidBuildVersion } from '../scripts/android-version.mjs';

const sha = 'b92f042c66d73285ccf53ba33c51163799303b2c';
describe('traceable Android build versions', () => {
  it('identifies the commit, run and retry while keeping versionCode monotonic', () => {
    expect(androidBuildVersion('100', '1', sha)).toEqual({ versionCode: 13001, versionName: '0.3.0+100.1.b92f042' });
    expect(androidBuildVersion('100', '2', sha).versionCode).toBeGreaterThan(androidBuildVersion('100', '1', sha).versionCode);
    expect(androidBuildVersion('101', '1', sha).versionCode).toBeGreaterThan(androidBuildVersion('100', '99', sha).versionCode);
  });
  it.each([[0, 1], [1.5, 1], [1, 0], [1, 100], [21000000, 1], ['bad', 1]])('rejects invalid or overflowing %s.%s', (run, attempt) => {
    expect(() => androidBuildVersion(run, attempt, sha)).toThrow();
  });
  it('rejects a missing or malformed source commit', () => {
    expect(() => androidBuildVersion(1, 1, 'main')).toThrow('SHA');
  });
});
