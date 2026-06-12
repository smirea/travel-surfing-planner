#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const home = process.env.HOME;
if (!home) {
	throw new Error('HOME is not set.');
}

const scriptsRepo = path.join(home, 'code', 'scripts');
const result = spawnSync('bun', [path.join(scriptsRepo, 'src', 'run.ts'), 'google-maps', ...process.argv.slice(2)], {
	cwd: process.cwd(),
	env: process.env,
	stdio: 'inherit',
});

if (result.error) {
	throw result.error;
}

if (result.signal) {
	console.error(`google-maps exited from signal ${result.signal}`);
	process.exit(1);
}

process.exit(result.status ?? 1);
