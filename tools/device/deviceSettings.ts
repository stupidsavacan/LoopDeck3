import { NIGHT_MODES, type NightMode, type TrackedSettingKey } from './constants.js';
import type { AdbDevice } from './adb.js';
import { DeviceCliError } from './errors.js';
import type { DeviceRun } from './runtime.js';

export type SettingRequest = { key: 'uimode'; value: 'yes' | 'no' | 'auto' } | { key: 'font_scale'; value: string };

/** CLI / scenario spellings: `uimode yes|no|auto`, `font-scale 0.5..2.0`. */
export function parseSettingRequest(name: string, value: string): SettingRequest {
  if (name === 'uimode') {
    if (value !== 'yes' && value !== 'no' && value !== 'auto')
      throw new DeviceCliError('USAGE', 'uimode must be yes (dark), no (light) or auto');
    return { key: 'uimode', value };
  }
  if (name === 'font-scale' || name === 'font_scale') {
    const scale = Number(value);
    if (!/^[0-9](\.[0-9]{1,2})?$/.test(value) || !(scale >= 0.5 && scale <= 2)) {
      throw new DeviceCliError('USAGE', 'font-scale must be a number from 0.5 to 2.0 with at most two decimals, e.g. 1.25');
    }
    return { key: 'font_scale', value };
  }
  throw new DeviceCliError('USAGE', 'setting name must be uimode or font-scale');
}

export interface SettingReport {
  setting: TrackedSettingKey;
  original: string | null;
  requested: string;
  actual: string | null;
}

async function readCurrent(device: AdbDevice, key: TrackedSettingKey): Promise<string | null> {
  return key === 'uimode' ? await device.getNightMode() : await device.getSetting('font_scale');
}

const sameValue = (key: TrackedSettingKey, a: string | null, b: string | null): boolean =>
  key === 'font_scale' && a !== null && b !== null ? Number(a) === Number(b) : a === b;

/**
 * Changes one device setting. The original value is written to the session BEFORE the change, and
 * only the first original is kept when the same setting is changed twice, so `finish` always goes
 * back to what the phone had before this session touched it.
 */
export async function applySetting(run: DeviceRun, request: SettingRequest): Promise<SettingReport> {
  const { device, session } = run;
  const key: TrackedSettingKey = request.key;
  const current = await readCurrent(device, key);
  const recorded = session.record.changedSettings?.[key];
  const original = recorded ? recorded.original : current;
  if (!recorded) {
    session.commit((draft) => {
      draft.changedSettings = { ...(draft.changedSettings ?? {}), [key]: { original: current } };
    });
  }
  if (request.key === 'uimode') await device.setNightMode(request.value);
  else await device.putSetting('font_scale', request.value);
  const actual = await readCurrent(device, key);
  if (!sameValue(key, actual, request.value)) {
    throw new DeviceCliError('ADB', `${key} was not applied: expected ${request.value}, device reports ${actual ?? 'unset'}`);
  }
  return { setting: key, original, requested: request.value, actual };
}

/** Puts one setting back and re-reads it. Throws unless the device reports the original again. */
export async function restoreSetting(device: AdbDevice, key: TrackedSettingKey, original: string | null): Promise<void> {
  if (key === 'uimode') {
    if (original === null || !(NIGHT_MODES as readonly string[]).includes(original))
      throw new Error('no valid original night mode was recorded');
    await device.setNightMode(original as NightMode);
  } else if (original === null) {
    await device.deleteSetting('font_scale');
  } else {
    await device.putSetting('font_scale', original);
  }
  const actual = await readCurrent(device, key);
  if (!sameValue(key, actual, original)) {
    throw new Error(`verification failed: expected ${original ?? 'unset'}, found ${actual ?? 'unset'}`);
  }
}
