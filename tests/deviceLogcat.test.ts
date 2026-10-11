import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../tools/device/lineSplitter';
import { LOGCAT_LIMITS, LogcatAnalyzer, isAppProcess, mentionsApp, parseEventFields, parseLogcatLine } from '../tools/device/logcat';
import { runScenario } from '../tools/device/runner';
import {
  APP,
  APP_UID,
  FakeAdb,
  FakeCdp,
  FakeLogcat,
  FakeSignals,
  fakeDeps,
  logLine,
  tempDir,
  type FakePageSpec
} from './helpers/deviceFakes';

const OTHER_UID = 10999;
const visibleCheck = { check: 'expectVisible', target: { css: '.home-screen' } };
const scenarioOf = (steps: unknown[]) => ({ schema: 1, id: 't', title: 'T', steps });
const read = (path: string) => readFileSync(path, 'utf8');
const journal = (runDir: string) =>
  read(join(runDir, 'events.ndjson'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

function setup(steps: unknown[] = [{ do: 'launch' }, visibleCheck]) {
  const dir = tempDir();
  const adb = new FakeAdb();
  const cdp = new FakeCdp();
  const logcat = new FakeLogcat();
  const signals = new FakeSignals();
  const deps = fakeDeps(adb, cdp, dir, logcat, signals);
  const spec: FakePageSpec = {
    url: 'https://appassets.androidplatform.net/assets/loopdeck/index.html#home',
    countVisible: () => 1,
    locate: () => ({ total: 1, visible: 1 }),
    evaluate: (_arg, fn) => {
      switch (fn.name) {
        case 'readDiagnostics':
          return { ok: true, entries: [] };
        case 'errorScreenPresent':
          return false;
        case 'domProbe':
          return { mode: 'snapshot', items: [], truncated: false, viewport: {}, href: '' };
        case 'captureStateInPage':
          return { ok: true, complete: true, version: 1, stores: [], reasons: [] };
        default:
          return undefined;
      }
    }
  };
  cdp.pages = [spec];
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenarioOf(steps)));
  const run = () => runScenario(deps, { serial: 'T1', scenarioPath, outDir: join(dir, 'out') });
  /** Runs `action` while the visibility check is being evaluated, i.e. during a step. */
  const during = (action: () => void) => {
    spec.countVisible = () => {
      action();
      return 1;
    };
  };
  return { dir, adb, cdp, logcat, signals, spec, run, during };
}

const crashEvent = (extra: { pid?: number; proc?: string } = {}) =>
  logLine({ uid: 1000, pid: 1788, tag: 'am_crash', msg: `[1788,0,${extra.proc ?? APP},552123974,Native crash,Trap,unknown,0,0]` });
const anrEvent = (proc = APP) =>
  logLine({ uid: 1000, pid: 1788, tag: 'am_anr', msg: `[0,4321,${proc},952741445,Input dispatching timed out, waiting for a window]` });
const diedEvent = (pid: number, proc = APP) => logLine({ uid: 1000, pid: 1788, tag: 'am_proc_died', msg: `[0,${pid},${proc},200,12]` });

describe('LineSplitter', () => {
  const collect = (maxLineChars = 100) => {
    const lines: [string, boolean][] = [];
    return { lines, splitter: new LineSplitter(maxLineChars, (line, truncated) => lines.push([line, truncated])) };
  };

  it('rebuilds whole lines from arbitrary chunk boundaries, CRLF and a missing final newline', () => {
    const { lines, splitter } = collect();
    for (const chunk of ['ab', 'c\r', '\ndef\nx', 'yz\r\n', 'tail']) splitter.push(chunk);
    splitter.flush();
    expect(lines.map(([line]) => line)).toEqual(['abc', 'def', 'xyz', 'tail']);
  });

  it('keeps a multi-byte character that is split across chunks', () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from('日本語ログ\n', 'utf8');
    splitter.push(bytes.subarray(0, 4)); // ends in the middle of the second character
    splitter.push(bytes.subarray(4));
    expect(lines).toEqual([['日本語ログ', false]]);
  });

  it('cuts an over-long line once, drops its rest, and recovers on the next line', () => {
    const { lines, splitter } = collect(10);
    splitter.push('x'.repeat(25));
    splitter.push('y'.repeat(25) + '\nnext\n');
    expect(lines).toEqual([
      ['x'.repeat(10), true],
      ['next', false]
    ]);
  });
});

describe('logcat parsing', () => {
  it('reads time, uid, pid, tid, priority and tag', () => {
    const parsed = parseLogcatLine('         1791731005.723 99045 19527 19528 E AndroidRuntime: FATAL EXCEPTION: main');
    expect(parsed).toEqual({
      epochMs: 1791731005723,
      uid: '99045',
      pid: 19527,
      tid: 19528,
      priority: 'E',
      tag: 'AndroidRuntime',
      message: 'FATAL EXCEPTION: main'
    });
  });

  it('reads symbolic uids, padded tags and event-log lines, and ignores buffer banners', () => {
    expect(parseLogcatLine('         1791731010.811  root  1097  1209 I libPowerHal: [perfNotifyAppState] x')?.uid).toBe('root');
    expect(parseLogcatLine('         1791731005.742 10241 12092 12092 F DEBUG   : #19 pc 00e8f70')?.tag).toBe('DEBUG');
    const event = parseLogcatLine('         1791731012.375  1000  1788  4593 I am_proc_died: [0,19484,com.loopdeck3.app.debug,200,12]');
    expect(event?.tag).toBe('am_proc_died');
    expect(parseEventFields(event?.message ?? '')).toEqual(['0', '19484', APP, '200', '12']);
    expect(parseLogcatLine('--------- beginning of crash')).toBeNull();
  });

  it('matches package names exactly, so look-alike packages are other apps', () => {
    expect(isAppProcess(APP)).toBe(true);
    expect(isAppProcess(`${APP}:worker`)).toBe(true);
    expect(isAppProcess(`${APP}x`)).toBe(false);
    expect(isAppProcess(`${APP}.other`)).toBe(false);
    expect(isAppProcess('com.google.android.webview:sandboxed_process0')).toBe(false);
  });
});

describe('ldev run: logcat channel', () => {
  it('streams device-wide (never --pid), from before the app starts, with events included', async () => {
    const { run, adb, logcat } = setup();
    let spawnsWhenAppStarted = -1;
    adb.failures.push((args) => {
      if (args.includes('start')) spawnsWhenAppStarted = logcat.spawns.length;
      return false;
    });
    await run();
    expect(spawnsWhenAppStarted).toBe(1);
    const { file, args } = logcat.spawns[0];
    expect(file).toBe('adb');
    expect(args.slice(0, 2)).toEqual(['-s', 'T1']);
    expect(args.join(' ')).toContain('logcat -v epoch,uid -b main,system,crash,events -T 1700000000.000');
    expect(args.some((arg) => arg.startsWith('--pid'))).toBe(false);
  });

  it('passes when the stream is healthy but quiet', async () => {
    const { run, logcat } = setup();
    const { summary } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.channels.find((channel) => channel.id === 'logcat')).toMatchObject({ status: 'ok', detail: null });
    expect(logcat.running).toBe(0);
  });

  it('FAILs on am_crash for the app and keeps the surrounding lines', async () => {
    const { run, logcat, during } = setup();
    during(() => {
      logcat.push(logLine({ pid: 4321, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' }));
      logcat.push(logLine({ pid: 4321, prio: 'E', tag: 'AndroidRuntime', msg: 'Process: com.loopdeck3.app.debug, PID: 4321' }));
      logcat.push(crashEvent());
      logcat.push(diedEvent(4321));
    });
    const { summary, runDir } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([
      { kind: 'androidFatalException', allowed: false, count: 1 },
      { kind: 'androidCrash', allowed: false, count: 1 }
    ]);
    const raw = read(join(runDir, 'logcat-stream.log'));
    expect(raw).toContain('FATAL EXCEPTION: main');
    expect(raw).toContain('am_crash');
    expect(raw).toContain('am_proc_died'); // the death after the crash is kept as evidence...
    expect(summary.anomalies.some((a) => a.kind === 'androidProcessDied')).toBe(false); // ...but not double counted
    expect(journal(runDir).some((e) => e.src === 'logcat' && e.type === 'amCrash')).toBe(true);
  });

  it('detects FATAL EXCEPTION from the Process line alone when the uid is unknown', async () => {
    const { run, adb, logcat, during } = setup();
    adb.failures.push((args) => args.includes('list') && args.includes('-U')); // uid lookup fails
    during(() => {
      logcat.push(logLine({ uid: 10777, pid: 900, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' }));
      logcat.push(logLine({ uid: 10777, pid: 900, prio: 'E', tag: 'AndroidRuntime', msg: `Process: ${APP}, PID: 900` }));
    });
    const { summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'androidFatalException', allowed: false, count: 1 }]);
  });

  it('FAILs on am_anr for the app', async () => {
    const { run, logcat, during } = setup();
    during(() => logcat.push(anrEvent()));
    const { summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'androidAnr', allowed: false, count: 1 }]);
  });

  it('FAILs on a process death nobody asked for', async () => {
    const { run, logcat, during } = setup();
    during(() => logcat.push(diedEvent(4321)));
    const { summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'androidProcessDied', allowed: false, count: 1 }]);
  });

  it('ignores crashes, ANRs and deaths of other apps, including look-alike package names', async () => {
    const { run, logcat, during } = setup();
    during(() => {
      logcat.push(logLine({ uid: OTHER_UID, pid: 777, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' }));
      logcat.push(logLine({ uid: OTHER_UID, pid: 777, prio: 'E', tag: 'AndroidRuntime', msg: 'Process: com.other.app, PID: 777' }));
      logcat.push(logLine({ uid: OTHER_UID, pid: 778, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' }));
      logcat.push(logLine({ uid: OTHER_UID, pid: 778, prio: 'E', tag: 'AndroidRuntime', msg: `Process: ${APP}.other, PID: 778` }));
      logcat.push(crashEvent({ proc: 'com.other.app' }));
      logcat.push(anrEvent('com.other.app'));
      logcat.push(diedEvent(777, 'com.other.app'));
      logcat.push(diedEvent(19527, 'com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0'));
      logcat.push(logLine({ uid: OTHER_UID, pid: 777, prio: 'E', tag: 'Other', msg: 'Something failed' }));
    });
    const { summary, runDir } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.anomalies).toEqual([]);
    expect(read(join(runDir, 'logcat-stream.log'))).not.toContain('com.other.app');
  });

  it('does not treat the force-stop of a relaunch as a crash, but a later death still counts', async () => {
    const { run, adb, logcat, during } = setup([{ do: 'launch' }, { do: 'lifecycle', action: 'relaunch' }, visibleCheck]);
    adb.failures.push((args) => {
      if (args.includes('force-stop')) {
        adb.pids = [5555];
        logcat.push(diedEvent(4321));
        logcat.push(
          logLine({ uid: 1000, pid: 1788, tag: 'am_proc_start', msg: `[0,5555,${APP_UID_NUM},${APP},activity,${APP}/.MainActivity]` })
        );
      }
      return false;
    });
    let seen = 0;
    during(() => {
      if (++seen === 1) logcat.push(diedEvent(5555)); // the new process dies on its own
    });
    const { summary, runDir } = await run();
    expect(summary.anomalies).toEqual([{ kind: 'androidProcessDied', allowed: false, count: 1 }]);
    expect(summary.final).toBe('FAIL');
    const types = journal(runDir)
      .filter((e) => e.src === 'logcat')
      .map((e) => e.type);
    expect(types).toContain('expectedExit');
  });

  it('passes a relaunch whose old process exits and whose new process stays up', async () => {
    const { run, adb, logcat } = setup([{ do: 'launch' }, { do: 'lifecycle', action: 'relaunch' }, visibleCheck]);
    adb.failures.push((args) => {
      if (args.includes('force-stop')) {
        adb.pids = [5555];
        logcat.push(diedEvent(4321));
      }
      return false;
    });
    const { summary } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.anomalies).toEqual([]);
  });

  it('still reports a crash of the previous pid after the app came back under a new pid', async () => {
    const { run, adb, logcat, during } = setup([{ do: 'launch' }, { do: 'lifecycle', action: 'relaunch' }, visibleCheck]);
    logcat.initial = [logLine({ pid: 4321, tag: 'LoopDeck', msg: 'old process alive' })];
    adb.failures.push((args) => {
      if (args.includes('force-stop')) {
        adb.pids = [5555];
        logcat.push(logLine({ pid: 5555, tag: 'LoopDeck', msg: 'new process alive' }));
      }
      return false;
    });
    during(() => {
      // Lines of the dead process arrive late; its pid must still be attributed to the app.
      logcat.push(logLine({ uid: 1000, pid: 4321, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' }));
    });
    const { summary, runDir } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'androidFatalException', allowed: false, count: 1 }]);
    const raw = read(join(runDir, 'logcat-stream.log'));
    expect(raw).toContain('old process alive');
    expect(raw).toContain('new process alive');
    expect(raw).toContain('FATAL EXCEPTION');
  });

  it('is INCONCLUSIVE when logcat cannot be started, without failing the run', async () => {
    const { run, logcat } = setup();
    logcat.startError = 'Executable not found: adb';
    const { summary } = await run();
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.channels.find((channel) => channel.id === 'logcat')).toMatchObject({ status: 'unavailable' });
    expect(summary.reasons.join('\n')).toContain('channel logcat is unavailable');
    expect(logcat.running).toBe(0);
  });

  it('is INCONCLUSIVE when logcat exits at once without output', async () => {
    const { run, logcat } = setup();
    logcat.exitAtOnce = { code: 1, stderr: 'error: device offline' };
    const { summary } = await run();
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.channels.find((channel) => channel.id === 'logcat')?.status).toBe('unavailable');
  });

  it('is INCONCLUSIVE when the stream dies mid-run, and keeps what it saw', async () => {
    const { run, logcat, during } = setup();
    logcat.initial = [logLine({ tag: 'LoopDeck', msg: 'hello from the app' })];
    during(() => logcat.end(1));
    const { summary, runDir } = await run();
    expect(summary.final).toBe('INCONCLUSIVE');
    expect(summary.channels.find((channel) => channel.id === 'logcat')).toMatchObject({ status: 'interrupted' });
    expect(read(join(runDir, 'logcat-stream.log'))).toContain('hello from the app');
  });

  it('FAIL still wins when the stream also broke', async () => {
    const { run, logcat, during } = setup();
    logcat.initial = [logLine({ tag: 'LoopDeck', msg: 'hello' })];
    during(() => {
      logcat.push(anrEvent());
      logcat.end(1);
    });
    expect((await run()).summary.final).toBe('FAIL');
  });

  it('does not let a quiet stream decide anything by itself', async () => {
    const { run, logcat } = setup();
    logcat.initial = [logLine({ tag: 'LoopDeck', msg: 'one line, then silence' })];
    const { summary } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.channels.find((channel) => channel.id === 'logcat')).toMatchObject({ status: 'ok', lines: 1, appLines: 1 });
  });

  it('stops the child on success, FAIL and ERROR', async () => {
    const ok = setup();
    await ok.run();
    expect([ok.logcat.running, ok.logcat.killed]).toEqual([0, 1]);

    const failing = setup();
    failing.during(() => failing.logcat.push(anrEvent()));
    expect((await failing.run()).summary.final).toBe('FAIL');
    expect(failing.logcat.running).toBe(0);

    const broken = setup();
    broken.cdp.connectError = new Error('refused');
    expect((await broken.run()).summary.final).toBe('ERROR');
    expect(broken.logcat.running).toBe(0);
    expect(broken.signals.installed).toBe(0);
  });

  it('kills the child and re-raises the signal on Ctrl+C / SIGTERM', async () => {
    const { run, logcat, signals, during } = setup();
    during(() => signals.emit('SIGINT'));
    expect(signals.installed).toBe(0);
    await run();
    expect(logcat.running).toBe(0);
    expect(signals.reraised).toEqual(['SIGINT']);
    expect(signals.installed).toBe(0);
  });

  it('turns the size cap into INCONCLUSIVE with the dropped count, and still catches a crash after it', async () => {
    const { run, logcat, during } = setup();
    const filler = logLine({ tag: 'Spam', msg: 'x'.repeat(1000) });
    during(() => {
      const lines = Math.ceil(LOGCAT_LIMITS.maxRawBytes / filler.length) + 50;
      logcat.push(filler.repeat(lines));
    });
    const { summary, runDir } = await run();
    expect(summary.final).toBe('INCONCLUSIVE');
    const channel = summary.channels.find((c) => c.id === 'logcat');
    expect(channel).toMatchObject({ status: 'interrupted' });
    expect((channel as { droppedLines: number }).droppedLines).toBeGreaterThan(0);
    expect(summary.reasons.join('\n')).toContain('size limit');
    expect(Buffer.byteLength(read(join(runDir, 'logcat-stream.log')))).toBeLessThanOrEqual(LOGCAT_LIMITS.maxRawBytes);

    const crash = setup();
    crash.during(() => {
      crash.logcat.push(filler.repeat(Math.ceil(LOGCAT_LIMITS.maxRawBytes / filler.length) + 50));
      crash.logcat.push(crashEvent());
    });
    const result = await crash.run();
    expect(result.summary.final).toBe('FAIL');
    expect(result.summary.anomalies).toContainEqual({ kind: 'androidCrash', allowed: false, count: 1 });
  });

  it('keeps raw log text out of summary.json but in the run directory', async () => {
    const { run, logcat, during } = setup();
    during(() => {
      logcat.push(logLine({ prio: 'W', tag: 'LoopDeck', msg: 'SECRET-LOG-BODY card text' }));
      logcat.push(logLine({ pid: 4321, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: SECRET-EXCEPTION-TEXT' }));
    });
    const { summary, runDir } = await run();
    expect(summary.final).toBe('FAIL');
    const written = read(join(runDir, 'summary.json'));
    expect(written).not.toContain('SECRET-LOG-BODY');
    expect(written).not.toContain('SECRET-EXCEPTION-TEXT');
    expect(read(join(runDir, 'logcat-stream.log'))).toContain('SECRET-LOG-BODY');
    expect(read(join(runDir, 'events.ndjson'))).toContain('SECRET-LOG-BODY'); // warnings and errors are journaled in time order
    expect(existsSync(join(runDir, 'failure'))).toBe(true);
  });

  it('keeps JavaScript detection working next to logcat', async () => {
    const { run, spec, cdp } = setup();
    spec.countVisible = () => {
      cdp.emit({ type: 'pageerror', message: 'boom' });
      return 1;
    };
    const { summary } = await run();
    expect(summary.final).toBe('FAIL');
    expect(summary.anomalies).toEqual([{ kind: 'jsException', allowed: false, count: 1 }]);
  });
});

describe('package attribution is exact', () => {
  it('matches the package only as a whole token', () => {
    expect(mentionsApp(`Process ${APP} (pid 1) has died`)).toBe(true);
    expect(mentionsApp(`crashed: ${APP}.`)).toBe(true);
    expect(mentionsApp(`start ${APP}/com.loopdeck3.app.MainActivity`)).toBe(true);
    expect(mentionsApp(`Process ${APP}.other (pid 1) has died`)).toBe(false);
    expect(mentionsApp(`Process ${APP}x (pid 1) has died`)).toBe(false);
    expect(mentionsApp(`Process x${APP} (pid 1) has died`)).toBe(false);
  });

  it('keeps other apps whose package starts with ours out of logcat-stream.log and the verdict', async () => {
    const { run, logcat, during } = setup();
    const other = `${APP}.other`;
    during(() => {
      logcat.push(logLine({ uid: OTHER_UID, pid: 777, prio: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' }));
      logcat.push(logLine({ uid: OTHER_UID, pid: 777, prio: 'E', tag: 'AndroidRuntime', msg: `Process: ${other}, PID: 777` }));
      logcat.push(
        logLine({ uid: OTHER_UID, pid: 777, prio: 'E', tag: 'AndroidRuntime', msg: 'java.lang.IllegalStateException: OTHER-APP-TRACE' })
      );
      logcat.push(logLine({ uid: 1000, pid: 1788, tag: 'am_crash', msg: `[777,0,${other},1,Native crash,Trap,unknown,0,0]` }));
      logcat.push(logLine({ uid: 1000, pid: 1788, tag: 'wm_finish_activity', msg: `[0,1,2,${other}/.MainActivity,force-crash]` }));
      logcat.push(logLine({ uid: 1000, pid: 1788, tag: 'ActivityManager', msg: `Process ${other} (pid 777) has died: fg TOP` }));
      logcat.push(diedEvent(777, other));
      logcat.push(logLine({ uid: OTHER_UID, pid: 778, tag: 'Launcher', msg: `starting ${APP} for the user` }));
      logcat.push(logLine({ uid: 1000, pid: 1788, tag: 'ActivityManager', msg: `Process ${APP} (pid 4321) is bound: SYSTEM-MENTION` }));
    });
    const { summary, runDir } = await run();
    expect(summary.final).toBe('PASS');
    expect(summary.anomalies).toEqual([]);
    const raw = read(join(runDir, 'logcat-stream.log'));
    expect(raw).not.toContain('OTHER-APP-TRACE');
    expect(raw).not.toContain(other);
    expect(raw).not.toContain('starting');
    expect(raw).toContain('SYSTEM-MENTION'); // a system component naming the exact package is evidence
  });

  it('does not attribute a reused pid of another app to ours', () => {
    const analyzer = new LogcatAnalyzer(APP_UID);
    const feed = (text: string) => analyzer.consume(parseLogcatLine(text.trimEnd())!);
    expect(feed(logLine({ pid: 4321, tag: 'LoopDeck', msg: 'mine' }))).toBe(true);
    expect(feed(logLine({ uid: OTHER_UID, pid: 4321, tag: 'Reused', msg: 'someone else now owns this pid' }))).toBe(false);
    expect(feed(logLine({ uid: 1000, pid: 4321, tag: 'ActivityManager', msg: 'system talks about pid 4321' }))).toBe(true);
  });
});

describe('process deaths are accounted per pid', () => {
  const analyzer = () => new LogcatAnalyzer(APP_UID);
  const kinds = (a: LogcatAnalyzer) => a.events.map((event) => event.anomaly);
  const feed = (a: LogcatAnalyzer, ...lines: string[]) => lines.forEach((text) => a.consume(parseLogcatLine(text.trimEnd())!));
  const started = (pid: number) =>
    logLine({ uid: 1000, pid: 1788, tag: 'am_proc_start', msg: `[0,${pid},${APP_UID},${APP},activity,${APP}/.MainActivity]` });

  it('consumes an intended exit, so the same pid dying again is a failure', () => {
    const a = analyzer();
    a.expectExit([4321]);
    feed(a, diedEvent(4321));
    expect(kinds(a)).toEqual([null]);
    expect(a.events[0].type).toBe('expectedExit');
    feed(a, diedEvent(4321));
    expect(kinds(a)).toEqual([null, 'androidProcessDied']);
  });

  it('does not excuse a reused pid: an unconsumed expectation ends when the pid is started again', () => {
    const a = analyzer();
    a.expectExit([4321]); // force-stop that logged no am_proc_died
    feed(a, started(4321), diedEvent(4321));
    expect(kinds(a)).toEqual([null, 'androidProcessDied']);
  });

  it('lets a crash or ANR explain only the pid it belongs to', () => {
    const a = analyzer();
    feed(a, started(4321), started(5555), anrEvent());
    expect(kinds(a)).toEqual([null, null, 'androidAnr']); // anrEvent() names pid 4321
    feed(a, diedEvent(5555)); // an unrelated process of the app dies
    expect(kinds(a).slice(3)).toEqual(['androidProcessDied']);
    feed(a, diedEvent(4321)); // the ANR'd process: already accounted for
    expect(kinds(a).slice(4)).toEqual([null]);
  });

  it('attributes a native crash (reported with the system pid) to the newest running pid only', () => {
    const a = analyzer();
    feed(a, started(4321), started(5555), crashEvent());
    feed(a, diedEvent(4321));
    expect(kinds(a)).toEqual([null, null, 'androidCrash', 'androidProcessDied']);
    feed(a, diedEvent(5555));
    expect(kinds(a).slice(4)).toEqual([null]);
  });

  it('ignores the crash dumper (same uid, other pid) when mapping a native crash to the app process', () => {
    const a = analyzer();
    feed(
      a,
      started(15391),
      logLine({ pid: 15391, tid: 15420, tag: 'LoopDeck', msg: 'main process alive' }),
      logLine({ pid: 15658, tag: 'linker64', msg: 'performing dump of process 15391 (target tid = 15391)' }),
      logLine({ uid: 1000, pid: 1788, tag: 'am_crash', msg: `[1788,0,${APP},552123974,Native crash,Trap,unknown,0,0]` }),
      diedEvent(15391)
    );
    expect(kinds(a)).toEqual([null, 'androidCrash', null]); // the death of the crashed process is explained, not a second failure
  });

  it('does not let one explained death hide a later one under the same pid', () => {
    const a = analyzer();
    feed(a, started(4321), crashEvent(), diedEvent(4321));
    feed(a, started(4321), diedEvent(4321)); // pid reused by a new process that dies on its own
    expect(kinds(a).filter((kind) => kind === 'androidProcessDied')).toHaveLength(1);
  });
});

const APP_UID_NUM = 10241;
