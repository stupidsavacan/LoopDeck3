import { ALLOWED_KEYS, TIMEOUTS } from './constants.js';
import { parseSettingRequest } from './deviceSettings.js';
import { DeviceCliError } from './errors.js';
import type { Direction } from './geometry.js';
import type { Locator } from './pageScripts.js';

export type StepDef =
  | { do: 'launch' }
  | { do: 'navigate'; route: string }
  | { do: 'tap'; target: Locator; native: boolean }
  | { do: 'swipe'; target: Locator; direction: Direction; distance: number; durationMs: number }
  | { do: 'type'; target: Locator; text: string }
  | { do: 'key'; key: string }
  | { do: 'rotate'; to: 'portrait' | 'landscape' }
  | { do: 'lifecycle'; action: 'background' | 'resume' | 'relaunch' | 'kill' }
  | { do: 'reset' }
  | { do: 'setting'; key: 'uimode' | 'font-scale'; value: string }
  | { do: 'installApk'; file: string; replaceIncompatible: boolean }
  | { do: 'wait'; ms: number }
  | { do: 'snapshotState'; label: string }
  | { do: 'injectError'; message: string }
  | { check: 'expectVisible'; target?: Locator; text?: string; timeoutMs: number }
  | { check: 'expectNoErrorScreen' }
  | { check: 'expectStateSame'; a: string; b: string };

export type Step = StepDef & { id: string };

export interface Scenario {
  schema: 1;
  id: string;
  title: string;
  allowConsoleErrors: { pattern: string; reason: string }[];
  steps: Step[];
  /** `harness` when the scenario deliberately breaks the app (injectError); `app` otherwise. */
  testClass: 'app' | 'harness';
}

const usage = (path: string, message: string): DeviceCliError => new DeviceCliError('USAGE', `${path}: ${message}`);

type Obj = Record<string, unknown>;

function object(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw usage(path, 'must be an object');
  return value as Obj;
}

function only(value: Obj, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw usage(`${path}.${key}`, 'unknown key');
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw usage(path, `must be a string of 1..${max} characters`);
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw usage(path, `must be an integer between ${min} and ${max}`);
  return value;
}

/** Same rules as the CLI's locatorFrom: role + exact name, or a non-empty CSS selector. */
function locator(value: unknown, path: string): Locator {
  const o = object(value, path);
  if ('css' in o) {
    only(o, path, ['css']);
    if (typeof o.css !== 'string' || !o.css.trim()) throw usage(`${path}.css`, 'must be a non-empty string');
    return { css: o.css };
  }
  only(o, path, ['role', 'name']);
  if (typeof o.role !== 'string' || !/^[a-z]{3,20}$/.test(o.role))
    throw usage(`${path}.role`, 'must be a lowercase ARIA role such as button');
  if (typeof o.name !== 'string') throw usage(`${path}.name`, 'must be a string (exact accessible name)');
  return { role: o.role, name: o.name };
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROUTE = /^#[A-Za-z0-9/._~%:?=&-]{0,199}$/;

function parseStep(raw: unknown, index: number, labels: Set<string>): StepDef {
  const path = `steps[${index}]`;
  const o = object(raw, path);
  const hasDo = 'do' in o;
  const hasCheck = 'check' in o;
  if (hasDo === hasCheck) throw usage(path, 'must have exactly one of "do" or "check"');

  if (hasDo) {
    const kind = o.do;
    switch (kind) {
      case 'launch':
        only(o, path, ['do']);
        return { do: 'launch' };
      case 'navigate':
        only(o, path, ['do', 'route']);
        if (typeof o.route !== 'string' || !ROUTE.test(o.route)) throw usage(`${path}.route`, 'must be a hash route starting with "#"');
        return { do: 'navigate', route: o.route };
      case 'tap':
        only(o, path, ['do', 'target', 'native']);
        if (o.native !== undefined && typeof o.native !== 'boolean') throw usage(`${path}.native`, 'must be a boolean');
        return { do: 'tap', target: locator(o.target, `${path}.target`), native: o.native === true };
      case 'swipe': {
        only(o, path, ['do', 'target', 'direction', 'distance', 'durationMs']);
        const direction = o.direction;
        if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right')
          throw usage(`${path}.direction`, 'must be up, down, left or right');
        return {
          do: 'swipe',
          target: locator(o.target, `${path}.target`),
          direction,
          distance: o.distance === undefined ? 120 : integer(o.distance, `${path}.distance`, 8, 2000),
          durationMs: o.durationMs === undefined ? 350 : integer(o.durationMs, `${path}.durationMs`, 50, 5000)
        };
      }
      case 'type':
        only(o, path, ['do', 'target', 'text']);
        if (typeof o.text !== 'string' || o.text.length > 1000) throw usage(`${path}.text`, 'must be a string of at most 1000 characters');
        return { do: 'type', target: locator(o.target, `${path}.target`), text: o.text };
      case 'key':
        only(o, path, ['do', 'key']);
        if (typeof o.key !== 'string' || !ALLOWED_KEYS.includes(o.key))
          throw usage(`${path}.key`, `must be one of: ${ALLOWED_KEYS.join(', ')}`);
        return { do: 'key', key: o.key };
      case 'rotate':
        only(o, path, ['do', 'to']);
        if (o.to !== 'portrait' && o.to !== 'landscape') throw usage(`${path}.to`, 'must be portrait or landscape');
        return { do: 'rotate', to: o.to };
      case 'lifecycle':
        only(o, path, ['do', 'action']);
        if (o.action !== 'background' && o.action !== 'resume' && o.action !== 'relaunch' && o.action !== 'kill')
          throw usage(`${path}.action`, 'must be background, resume, relaunch or kill');
        return { do: 'lifecycle', action: o.action };
      case 'reset':
        only(o, path, ['do']);
        return { do: 'reset' };
      case 'setting': {
        only(o, path, ['do', 'key', 'value']);
        if (o.key !== 'uimode' && o.key !== 'font-scale') throw usage(`${path}.key`, 'must be uimode or font-scale');
        // Same validation as the CLI, so a bad value is a usage error before the device is touched.
        const value = typeof o.value === 'number' ? String(o.value) : o.value;
        if (typeof value !== 'string') throw usage(`${path}.value`, 'must be a string (uimode) or a number (font-scale)');
        try {
          parseSettingRequest(o.key, value);
        } catch (error) {
          throw usage(`${path}.value`, (error as Error).message);
        }
        return { do: 'setting', key: o.key, value };
      }
      case 'installApk':
        only(o, path, ['do', 'file', 'replaceIncompatible']);
        if (o.replaceIncompatible !== undefined && typeof o.replaceIncompatible !== 'boolean')
          throw usage(`${path}.replaceIncompatible`, 'must be a boolean');
        return { do: 'installApk', file: text(o.file, `${path}.file`, 500), replaceIncompatible: o.replaceIncompatible === true };
      case 'wait':
        only(o, path, ['do', 'ms']);
        return { do: 'wait', ms: integer(o.ms, `${path}.ms`, 1, 30_000) };
      case 'snapshotState': {
        only(o, path, ['do', 'label']);
        if (typeof o.label !== 'string' || !LABEL.test(o.label)) throw usage(`${path}.label`, 'must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
        if (o.label === 'now' || labels.has(o.label)) throw usage(`${path}.label`, 'must be unique and not "now"');
        labels.add(o.label);
        return { do: 'snapshotState', label: o.label };
      }
      case 'injectError':
        only(o, path, ['do', 'message']);
        return { do: 'injectError', message: text(o.message, `${path}.message`, 200) };
      default:
        throw usage(`${path}.do`, `unknown step "${String(kind)}"`);
    }
  }

  switch (o.check) {
    case 'expectVisible': {
      only(o, path, ['check', 'target', 'text', 'timeoutMs']);
      if ((o.target === undefined) === (o.text === undefined)) throw usage(path, 'expectVisible needs exactly one of "target" or "text"');
      const timeoutMs = o.timeoutMs === undefined ? TIMEOUTS.expectMs : integer(o.timeoutMs, `${path}.timeoutMs`, 0, TIMEOUTS.maxExpectMs);
      if (o.text !== undefined) return { check: 'expectVisible', text: text(o.text, `${path}.text`, 500), timeoutMs };
      return { check: 'expectVisible', target: locator(o.target, `${path}.target`), timeoutMs };
    }
    case 'expectNoErrorScreen':
      only(o, path, ['check']);
      return { check: 'expectNoErrorScreen' };
    case 'expectStateSame': {
      only(o, path, ['check', 'a', 'b']);
      if (typeof o.a !== 'string' || !labels.has(o.a)) throw usage(`${path}.a`, 'must name an earlier snapshotState label');
      if (typeof o.b !== 'string' || (o.b !== 'now' && !labels.has(o.b)))
        throw usage(`${path}.b`, 'must name an earlier snapshotState label, or "now"');
      return { check: 'expectStateSame', a: o.a, b: o.b };
    }
    default:
      throw usage(`${path}.check`, `unknown check "${String(o.check)}"`);
  }
}

export function parseScenario(source: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new DeviceCliError('USAGE', 'scenario: not valid JSON');
  }
  const root = object(parsed, 'scenario');
  only(root, 'scenario', ['schema', 'id', 'title', 'allowConsoleErrors', 'steps']);
  if (root.schema !== 1) throw usage('schema', 'must be 1');
  if (typeof root.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(root.id)) throw usage('id', 'must match [A-Za-z0-9._-]{1,64}');
  const title = text(root.title, 'title', 200);

  const allowConsoleErrors: Scenario['allowConsoleErrors'] = [];
  if (root.allowConsoleErrors !== undefined) {
    if (!Array.isArray(root.allowConsoleErrors)) throw usage('allowConsoleErrors', 'must be an array');
    root.allowConsoleErrors.forEach((entry: unknown, index: number) => {
      const path = `allowConsoleErrors[${index}]`;
      const o = object(entry, path);
      only(o, path, ['pattern', 'reason']);
      const pattern = text(o.pattern, `${path}.pattern`, 500);
      try {
        new RegExp(pattern);
      } catch {
        throw usage(`${path}.pattern`, 'is not a valid regular expression');
      }
      allowConsoleErrors.push({ pattern, reason: text(o.reason, `${path}.reason`, 500) });
    });
  }

  if (!Array.isArray(root.steps) || root.steps.length === 0) throw usage('steps', 'must be a non-empty array');
  const labels = new Set<string>();
  const steps = root.steps.map((raw: unknown, index: number): Step => ({ ...parseStep(raw, index, labels), id: `s${index}` }));
  const testClass = steps.some((step) => 'do' in step && step.do === 'injectError') ? 'harness' : 'app';
  return { schema: 1, id: root.id, title, allowConsoleErrors, steps, testClass };
}
