#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

process.stdout.write('started\n');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setTimeout(() => {}, 30000)'], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.once('message', () => {
  const pidFile = process.env.STUBBORN_PID_FILE;
  if (!pidFile) process.exit(1);
  writeFileSync(pidFile, String(child.pid));
});
child.on('error', () => process.exit(1));

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
