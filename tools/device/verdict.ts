export type Final = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR';

export interface VerdictInput {
  checks: { id: string; status: 'PASS' | 'FAIL' | 'NOT_EVALUATED' }[];
  anomalies: { kind: string; allowed: boolean }[];
  /** Why the steps could not be run to the end; null when they were. */
  infraError: string | null;
  channels: { id: 'js' | 'diag'; status: 'ok' | 'unavailable' | 'interrupted' }[];
  stateIncompleteForCheck: boolean;
}

/**
 * Precedence: FAIL, then ERROR, then INCONCLUSIVE, then PASS. PASS needs at least one PASSing
 * check, so a run that asserted nothing can never pass. `reasons` lists every condition that holds.
 */
export function computeVerdict(input: VerdictInput): { final: Final; reasons: string[] } {
  const failed: string[] = [];
  const doubtful: string[] = [];
  const reasons: string[] = [];

  for (const check of input.checks) if (check.status === 'FAIL') failed.push(`check ${check.id} failed`);
  for (const anomaly of input.anomalies) if (!anomaly.allowed) failed.push(`unallowed anomaly: ${anomaly.kind}`);
  if (input.infraError !== null) reasons.push(`infrastructure error: ${input.infraError}`);

  if (!input.checks.some((check) => check.status === 'PASS')) doubtful.push('no check passed');
  for (const check of input.checks) if (check.status === 'NOT_EVALUATED') doubtful.push(`check ${check.id} was not evaluated`);
  for (const channel of input.channels) if (channel.status !== 'ok') doubtful.push(`channel ${channel.id} is ${channel.status}`);
  if (input.stateIncompleteForCheck) doubtful.push('state capture needed by a check was incomplete');

  const final: Final = failed.length > 0 ? 'FAIL' : input.infraError !== null ? 'ERROR' : doubtful.length > 0 ? 'INCONCLUSIVE' : 'PASS';
  return { final, reasons: [...failed, ...reasons, ...doubtful] };
}
