import { describe, expect, it } from 'vitest';
import { computeVerdict, type VerdictInput } from '../tools/device/verdict';

const clean = (overrides: Partial<VerdictInput> = {}): VerdictInput => ({
  checks: [{ id: 's1', status: 'PASS' }],
  anomalies: [],
  infraError: null,
  channels: [
    { id: 'js', status: 'ok' },
    { id: 'diag', status: 'ok' }
  ],
  stateIncompleteForCheck: false,
  ...overrides
});

describe('computeVerdict', () => {
  it('FAIL beats ERROR when a check failed and the run also hit an infrastructure error', () => {
    const { final, reasons } = computeVerdict(clean({ checks: [{ id: 's1', status: 'FAIL' }], infraError: 'adb gone' }));
    expect(final).toBe('FAIL');
    expect(reasons.join('\n')).toContain('adb gone'); // every holding condition is listed
  });

  it('is ERROR with only an infrastructure error', () => {
    expect(computeVerdict(clean({ infraError: 'adb gone' })).final).toBe('ERROR');
  });

  it('is INCONCLUSIVE with no checks', () => {
    expect(computeVerdict(clean({ checks: [] })).final).toBe('INCONCLUSIVE');
  });

  it('is INCONCLUSIVE when any check was not evaluated, even next to a PASS', () => {
    const checks: VerdictInput['checks'] = [
      { id: 's1', status: 'PASS' },
      { id: 's2', status: 'NOT_EVALUATED' }
    ];
    expect(computeVerdict(clean({ checks })).final).toBe('INCONCLUSIVE');
  });

  it('is INCONCLUSIVE when the js channel was interrupted', () => {
    const channels: VerdictInput['channels'] = [
      { id: 'js', status: 'interrupted' },
      { id: 'diag', status: 'ok' }
    ];
    expect(computeVerdict(clean({ channels })).final).toBe('INCONCLUSIVE');
  });

  it('does not fail on allowed anomalies alone', () => {
    expect(computeVerdict(clean({ anomalies: [{ kind: 'consoleError', allowed: true }] })).final).toBe('PASS');
    expect(computeVerdict(clean({ anomalies: [{ kind: 'jsException', allowed: false }] })).final).toBe('FAIL');
  });

  it('is PASS with a passing check and nothing else', () => {
    expect(computeVerdict(clean())).toEqual({ final: 'PASS', reasons: [] });
  });

  it('never passes without at least one PASS check, over every combination', () => {
    const statuses: VerdictInput['checks'][number]['status'][] = ['PASS', 'FAIL', 'NOT_EVALUATED'];
    const channelStates = ['ok', 'unavailable', 'interrupted'] as const;
    for (const a of statuses)
      for (const b of statuses)
        for (const withB of [false, true])
          for (const anomaly of [null, true, false])
            for (const infraError of [null, 'x'])
              for (const js of channelStates)
                for (const diag of channelStates)
                  for (const stateIncompleteForCheck of [false, true]) {
                    const checks = [{ id: 'a', status: a }, ...(withB ? [{ id: 'b', status: b }] : [])];
                    const { final } = computeVerdict({
                      checks,
                      anomalies: anomaly === null ? [] : [{ kind: 'k', allowed: anomaly }],
                      infraError,
                      channels: [
                        { id: 'js', status: js },
                        { id: 'diag', status: diag }
                      ],
                      stateIncompleteForCheck
                    });
                    if (!checks.some((check) => check.status === 'PASS')) expect(final).not.toBe('PASS');
                  }
  });
});
