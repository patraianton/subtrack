import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psEscape, sanitizeTaskName, splitCommandLine, restartTaskScript, stopTaskScript, registerScript, makeRunServiceAction } from '../../src/ops/actions.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveServices } from '../../src/ops/config.ts';

test('psEscape doubles single quotes', () => {
  assert.equal(psEscape("a'b"), "a''b");
  assert.equal(psEscape('plain'), 'plain');
});

test('sanitizeTaskName keeps only safe chars', () => {
  assert.equal(sanitizeTaskName('my task/#1'), 'my-task--1');
  assert.equal(sanitizeTaskName('radar_healthcheck'), 'radar_healthcheck');
  assert.match(sanitizeTaskName(''), /^subtrack-adopted$/);
});

test('splitCommandLine handles a quoted exe path with args', () => {
  const { exe, args } = splitCommandLine('"C:\\\\Program Files\\\\nodejs\\\\node.exe" server.js --port 3000');
  assert.equal(exe, 'C:\\\\Program Files\\\\nodejs\\\\node.exe');
  assert.equal(args, 'server.js --port 3000');
});

test('splitCommandLine handles an unquoted exe', () => {
  const { exe, args } = splitCommandLine('pythonw.exe bot.py');
  assert.equal(exe, 'pythonw.exe');
  assert.equal(args, 'bot.py');
});

test('splitCommandLine on empty input yields empty exe', () => {
  assert.deepEqual(splitCommandLine('   '), { exe: '', args: '' });
});

test('restartTaskScript / stopTaskScript build escaped Start/Stop commands', () => {
  assert.match(restartTaskScript("rad'ar"), /Start-ScheduledTask -TaskName 'rad''ar'/);
  assert.match(restartTaskScript('x'), /'STARTED'/);
  assert.match(stopTaskScript('x'), /Stop-ScheduledTask -TaskName 'x'/);
  assert.match(stopTaskScript('x'), /'STOPPED'/);
});

test('registerScript builds an at-logon task with escaped values and prints REGISTERED', () => {
  const s = registerScript('subtrack-adopted-node-42', 'C:\\\\node.exe', 'app.js', 'C:\\\\app');
  assert.match(s, /New-ScheduledTaskAction -Execute 'C:\\\\node\.exe' -Argument 'app\.js' -WorkingDirectory 'C:\\\\app'/);
  assert.match(s, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(s, /LogonType Interactive/);
  assert.match(s, /Register-ScheduledTask -TaskName 'subtrack-adopted-node-42'/);
  assert.match(s, /'REGISTERED'/);
});

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-act-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

// A fake runner that records every script it was handed and returns canned results in
// sequence (the last result repeats for any further calls — a `register` action makes
// two `run` calls: the system-state gather, then the Register-ScheduledTask script).
function recorder(...results: { code: number; stdout: string; stderr: string }[]) {
  const calls: string[] = [];
  let i = 0;
  const run = async (script: string) => {
    calls.push(script);
    const idx = Math.min(i, results.length - 1);
    i += 1;
    return results[idx]!;
  };
  return { run, calls };
}

const OK = { code: 0, stdout: 'STARTED\n', stderr: '' };

test('restart runs Start-ScheduledTask for the service’s taskName', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'radar', label: 'Radar', kind: 'task', taskName: 'Radar-Spike8', alwaysOn: true }], base);
    const rec = recorder(OK);
    const run = makeRunServiceAction({ base, run: rec.run });
    const res = await run({ action: 'restart', id: 'radar' });
    assert.equal(res.ok, true);
    assert.match(rec.calls[0]!, /Start-ScheduledTask -TaskName 'Radar-Spike8'/);
  });
});

test('restart on an unknown id returns an error, runs nothing', async () => {
  await withTempBase(async (base) => {
    await saveServices([], base);
    const rec = recorder(OK);
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'restart', id: 'ghost' });
    assert.equal(res.ok, false);
    assert.match(res.error!, /unknown service/);
    assert.equal(rec.calls.length, 0);
  });
});

test('restart on a service with no taskName errors, runs nothing', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'web', label: 'Web', kind: 'http', port: 8080, alwaysOn: true }], base);
    const rec = recorder(OK);
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'restart', id: 'web' });
    assert.equal(res.ok, false);
    assert.match(res.error!, /no task/);
    assert.equal(rec.calls.length, 0);
  });
});

test('register rebuilds the task from the live process, never from the request', async () => {
  await withTempBase(async (base) => {
    // system-state gather returns one process for pid 4242
    const sys = JSON.stringify({ tasks: [], ports: [], processes: [{ pid: 4242, name: 'node', cmd: '"C:\\\\Program Files\\\\nodejs\\\\node.exe" bot.js' }] });
    const rec = recorder({ code: 0, stdout: sys, stderr: '' }, { code: 0, stdout: 'REGISTERED\n', stderr: '' });
    const res = await makeRunServiceAction({ base, run: rec.run, now: () => 1 })({ action: 'register', pid: 4242, label: 'my bot!!' });
    assert.equal(res.ok, true);
    assert.equal(res.taskName, 'my-bot'); // sanitized
    // the register script used the DETECTED exe/args, and the system-state gather ran first
    const registerCall = rec.calls.find((c) => c.includes('Register-ScheduledTask'))!;
    assert.match(registerCall, /-Execute 'C:\\\\Program Files\\\\nodejs\\\\node\.exe'/);
    assert.match(registerCall, /-Argument 'bot\.js'/);
  });
});

test('register on an absent pid errors, registers nothing', async () => {
  await withTempBase(async (base) => {
    const rec = recorder({ code: 0, stdout: '{"tasks":[],"ports":[],"processes":[]}', stderr: '' });
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'register', pid: 999 });
    assert.equal(res.ok, false);
    assert.match(res.error!, /no running process/);
    assert.ok(!rec.calls.some((c) => c.includes('Register-ScheduledTask')));
  });
});

test('a PowerShell failure surfaces as ok:false with the error tail', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'radar', label: 'Radar', kind: 'task', taskName: 'Radar', alwaysOn: true }], base);
    const rec = recorder({ code: 1, stdout: '', stderr: 'Access is denied.' });
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'restart', id: 'radar' });
    assert.equal(res.ok, false);
    assert.match(res.error!, /Access is denied/);
  });
});
