import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DeviceCliError } from '../tools/device/errors';
import { parseScenario } from '../tools/device/scenario';

const base = (extra: Record<string, unknown> = {}, steps: unknown[] = [{ do: 'launch' }]) =>
  JSON.stringify({ schema: 1, id: 'sample', title: 'Sample', steps, ...extra });

function rejection(text: string): string {
  try {
    parseScenario(text);
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceCliError);
    expect((error as DeviceCliError).code).toBe('USAGE');
    return (error as DeviceCliError).message;
  }
  throw new Error('expected parseScenario to reject');
}

describe('parseScenario', () => {
  it('accepts the bundled sample scenario', () => {
    const scenario = parseScenario(readFileSync('qa/scenarios/launch-home.json', 'utf8'));
    expect(scenario.id).toBe('launch-home');
    expect(scenario.steps).toHaveLength(4);
    expect(scenario.testClass).toBe('app');
  });

  it('rejects unknown keys at every level, naming the JSON path', () => {
    expect(rejection(base({ extra: 1 }))).toContain('scenario.extra');
    expect(rejection(base({}, [{ do: 'launch' }, { do: 'tap', target: { css: '.a' }, speed: 1 }]))).toContain('steps[1].speed');
    expect(rejection(base({}, [{ do: 'tap', target: { css: '.a', role: 'button' } }]))).toContain('steps[0].target.role');
  });

  it('rejects a step with both do and check, or neither', () => {
    expect(rejection(base({}, [{ do: 'launch', check: 'expectNoErrorScreen' }]))).toContain('steps[0]');
    expect(rejection(base({}, [{ ms: 5 }]))).toContain('steps[0]');
  });

  it('rejects empty steps, bad routes, bad regular expressions and out-of-range waits', () => {
    expect(rejection(base({}, []))).toContain('steps');
    expect(rejection(base({}, [{ do: 'navigate', route: 'home' }]))).toContain('steps[0].route');
    expect(rejection(base({ allowConsoleErrors: [{ pattern: '(', reason: 'x' }] }))).toContain('allowConsoleErrors[0].pattern');
    expect(rejection(base({}, [{ do: 'wait', ms: 0 }]))).toContain('steps[0].ms');
    expect(rejection(base({}, [{ do: 'wait', ms: 30_001 }]))).toContain('steps[0].ms');
  });

  it('validates locators like the CLI does', () => {
    expect(rejection(base({}, [{ do: 'tap', target: { role: 'Button', name: 'x' } }]))).toContain('steps[0].target.role');
    expect(rejection(base({}, [{ do: 'tap', target: { css: '  ' } }]))).toContain('steps[0].target.css');
    expect(parseScenario(base({}, [{ do: 'tap', target: { role: 'button', name: 'OK' } }])).steps[0]).toMatchObject({
      do: 'tap',
      native: false
    });
  });

  it('requires state labels to be defined before they are compared', () => {
    expect(rejection(base({}, [{ check: 'expectStateSame', a: 'x', b: 'now' }]))).toContain('steps[0].a');
    const ok = parseScenario(
      base({}, [
        { do: 'snapshotState', label: 'x' },
        { check: 'expectStateSame', a: 'x', b: 'now' }
      ])
    );
    expect(ok.steps).toHaveLength(2);
  });

  it('classifies a scenario containing injectError as harness', () => {
    expect(parseScenario(base({}, [{ do: 'launch' }, { do: 'injectError', message: 'boom' }])).testClass).toBe('harness');
  });
});
