import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const envLinePattern = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export function readEnvLocalValues(filePath: string): Record<string, string> {
	if (!existsSync(filePath)) {
		return {};
	}

	const values: Record<string, string> = {};
	for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
		const match = envLinePattern.exec(line);
		if (!match) {
			continue;
		}
		values[match[1]] = unquoteEnvValue(line.slice(match[0].length));
	}
	return values;
}

export function writeEnvLocalValues(filePath: string, updates: Record<string, string | undefined>): void {
	const pending = new Map(Object.entries(updates).filter((entry): entry is [string, string] => entry[1] !== undefined));
	const lines = existsSync(filePath) ? readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
	const nextLines = lines.map(line => {
		const match = envLinePattern.exec(line);
		if (!match || !pending.has(match[1])) {
			return line;
		}
		const value = pending.get(match[1]);
		pending.delete(match[1]);
		return `${match[1]}=${value ?? ''}`;
	});

	for (const [name, value] of pending) {
		nextLines.push(`${name}=${value}`);
	}

	while (nextLines.length > 0 && nextLines.at(-1) === '') {
		nextLines.pop();
	}
	writeFileSync(filePath, `${nextLines.join('\n')}\n`, { mode: 0o600 });
}

function unquoteEnvValue(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}
