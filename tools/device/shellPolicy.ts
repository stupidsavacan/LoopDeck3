import { APP_PACKAGE, SHELL_WRITE_ROOTS } from './constants.js';
import { DeviceCliError } from './errors.js';

/**
 * What `ldev shell` will run. This is an argv allowlist, not a sandbox:
 *
 * - Every argument is quoted individually (adb.ts shellQuote), so `;`, `|`, `&&`, `$()` and
 *   redirections arrive as literal text. Commands cannot be chained, and shells/interpreters are
 *   not in the allowlist, so `sh -c "..."` is refused.
 * - Package-targeting operations (`pm clear|uninstall|...`, `am force-stop|kill|crash`) only accept
 *   exactly com.loopdeck3.app.debug. The release package and every other app are refused.
 * - Device-wide operations are refused: reboot, shutdown, recovery, fastboot, factory reset, svc, setprop.
 *   Settings changes go through `ldev setting` / `ldev rotate` so `finish` can restore them.
 * - File-changing commands may only touch the tool's own scratch space (SHELL_WRITE_ROOTS).
 *
 * What it does NOT promise: an allowed command (`input`, `am start`, `am broadcast`, `dumpsys`, ...)
 * still acts on the real phone with the shell user's rights, and the check looks at argument text
 * only. It cannot isolate the phone and does not try to.
 */

const READ_COMMANDS = new Set([
  'getprop',
  'logcat',
  'ps',
  'pidof',
  'date',
  'echo',
  'id',
  'df',
  'uptime',
  'uname',
  'cat',
  'ls',
  'stat',
  'head',
  'tail',
  'grep',
  'wc',
  'sha256sum',
  'md5sum',
  'sleep',
  'pwd',
  'whoami',
  'getenforce',
  'screencap',
  'uiautomator',
  'input',
  'dumpsys',
  'true'
]);
const FILE_COMMANDS = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'truncate']);

/** pm verbs that only read. */
const PM_READ = new Set([
  'list',
  'path',
  'dump',
  'resolve-activity',
  'query-activities',
  'has-feature',
  'get-max-users',
  'get-install-location'
]);
/** pm verbs that change a package; allowed only for the debug package. */
const PM_APP_ONLY = new Set(['clear', 'uninstall', 'grant', 'revoke', 'disable-user', 'enable']);
const AM_APP_ONLY = new Set(['force-stop', 'kill', 'crash']);
const AM_OTHER = new Set([
  'start',
  'start-activity',
  'startservice',
  'start-service',
  'stopservice',
  'stop-service',
  'broadcast',
  'get-current-user'
]);

/** Anywhere in the argv: device-wide destruction or power state. */
const DEVICE_WIDE = /reboot|shutdown|recovery|fastboot|bootloader|master_?clear|factory_?reset|powerctl|wipe|sideload|flash/i;

const PACKAGE_LIKE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const isPackageToken = (token: string): boolean => PACKAGE_LIKE.test(token) && !/^android\./.test(token);

const refuse = (reason: string): never => {
  throw new DeviceCliError('UNSAFE', `ldev shell refused: ${reason}`);
};

/** Throws DeviceCliError('UNSAFE') unless this argv is allowed. */
export function checkShellArgv(argv: readonly string[]): void {
  if (argv.length === 0) refuse('no command given');
  if (argv.length > 64 || argv.some((arg) => arg.length > 4096)) refuse('command is too long');
  const [command, ...args] = argv;

  if (argv.some((arg) => DEVICE_WIDE.test(arg)))
    refuse('device-wide operations (reboot, recovery, fastboot, factory reset) are out of scope');
  if (command === 'pm' || (command === 'cmd' && args[0] === 'package')) {
    const verb = command === 'pm' ? args[0] : args[1];
    const rest = command === 'pm' ? args.slice(1) : args.slice(2);
    if (verb !== undefined && PM_READ.has(verb)) return;
    if (verb === undefined || !PM_APP_ONLY.has(verb)) refuse(`pm ${verb ?? ''} is not allowed (install goes through "ldev install")`);
    requireOnlyDebugPackage(`pm ${verb}`, rest);
    return;
  }

  if (command === 'am' || (command === 'cmd' && args[0] === 'activity')) {
    const verb = command === 'am' ? args[0] : args[1];
    const rest = command === 'am' ? args.slice(1) : args.slice(2);
    if (verb !== undefined && AM_APP_ONLY.has(verb)) {
      requireOnlyDebugPackage(`am ${verb}`, rest);
      return;
    }
    if (verb === undefined || !AM_OTHER.has(verb)) refuse(`am ${verb ?? ''} is not allowed`);
    return;
  }

  if (command === 'cmd') {
    if (args.length === 2 && args[0] === 'uimode' && args[1] === 'night') return; // query only
    refuse('cmd is limited to "cmd package", "cmd activity" and the "cmd uimode night" query (change it with "ldev setting")');
  }

  if (command === 'settings') {
    if (args[0] === 'get' || args[0] === 'list') return;
    refuse('settings can only be read here; change them with "ldev setting" or "ldev rotate" so finish can restore them');
  }

  if (command === 'wm') {
    if (args.length === 1 && (args[0] === 'size' || args[0] === 'density')) return; // query only
    refuse('wm is limited to the "wm size" and "wm density" queries');
  }

  if (command === 'dumpsys' && args[0] === 'battery' && args.length > 1) refuse('dumpsys battery cannot change the battery state');

  if (FILE_COMMANDS.has(command)) {
    const paths = args.filter((arg) => !arg.startsWith('-') && !/^[0-7]{3,4}$/.test(arg));
    if (paths.length === 0) refuse(`${command} needs a path inside the tool's scratch space`);
    for (const path of paths) {
      const normalized = path.split('/').includes('..');
      if (normalized || !SHELL_WRITE_ROOTS.some((root) => path.startsWith(root))) {
        refuse(`${command} may only touch ${SHELL_WRITE_ROOTS.slice(0, 3).join(', ')} (and the debug app's external dir), not "${path}"`);
      }
    }
    return;
  }

  if (!READ_COMMANDS.has(command)) {
    refuse(`"${command}" is not an allowed command (shells, su, run-as, svc, setprop and similar are never allowed)`);
  }
}

/** Destructive package verbs: the debug package must be named, and no other package may be. */
function requireOnlyDebugPackage(what: string, args: readonly string[]): void {
  const packages = args.filter(isPackageToken);
  if (!packages.includes(APP_PACKAGE)) refuse(`${what} must name ${APP_PACKAGE}`);
  const other = packages.find((token) => token !== APP_PACKAGE);
  if (other !== undefined) refuse(`${what} may only target ${APP_PACKAGE}, not "${other}"`);
}
