#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
writeFileSync(process.env.STUBBORN_PID_FILE, String(child.pid));

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
