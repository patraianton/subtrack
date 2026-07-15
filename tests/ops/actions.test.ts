import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psEscape, sanitizeTaskName, splitCommandLine, restartTaskScript, stopTaskScript, registerScript } from '../../src/ops/actions.ts';

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
