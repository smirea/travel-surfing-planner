#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import path from 'node:path';

interface ResultRow {
	line: string;
	name: string;
	detailFile: string;
}

interface Replacement {
	file: string;
	line: number;
	before: string;
	after: string;
}

const rootDir = path.resolve(import.meta.dir, '..');
const dataDir = path.join(rootDir, 'data');
const resultPath = path.join(dataDir, 'result.md');
const auditPath = path.join(dataDir, 'usd_price_conversion_audit.md');
const rates = {
	EUR: 1 / 0.853688,
	GBP: 1 / 0.739635,
	IDR: 1 / 17507.140588,
	MXN: 1 / 17.188343,
} as const;
const rateSource = 'https://open.er-api.com/v6/latest/USD';
const rateTimestamp = 'Thu, 14 May 2026 00:02:31 +0000';

const resultMarkdown = await Bun.file(resultPath).text();
const rows = parseResultRows(resultMarkdown);
const files = [resultPath, ...rows.map(row => path.join(dataDir, row.detailFile))];
const replacements: Replacement[] = [];

for (const file of files) {
	const markdown = await Bun.file(file).text();
	const converted = convertMarkdown(file, markdown, replacements);
	if (converted !== markdown) {
		await Bun.write(file, converted);
	}
}

await Bun.write(resultPath, updateResultIntro(await Bun.file(resultPath).text()));
if (replacements.length || !existsSync(auditPath)) {
	await Bun.write(auditPath, renderAudit(replacements));
}

console.log(
	JSON.stringify(
		{
			filesChecked: files.length,
			linesConverted: replacements.length,
			audit: path.relative(rootDir, auditPath),
		},
		null,
		2,
	),
);

function convertMarkdown(file: string, markdown: string, replacements: Replacement[]): string {
	return markdown
		.split('\n')
		.map((line, index) => {
			const converted = convertMoneyText(line);
			if (converted !== line) {
				replacements.push({
					file: path.relative(rootDir, file),
					line: index + 1,
					before: line,
					after: converted,
				});
			}
			return converted;
		})
		.join('\n');
}

function convertMoneyText(text: string): string {
	return text
		.replace(
			/\b(EUR|GBP|IDR|MXN)\s+(\d[\d,]*(?:\.\d+)?)(\s*-\s*)(?:\1\s*)?(\d[\d,]*(?:\.\d+)?)/g,
			(_, currency: keyof typeof rates, left: string, separator: string, right: string) =>
				`${formatUsd(convertAmount(currency, left))}${separator}${formatUsd(convertAmount(currency, right))}`,
		)
		.replace(/\b(EUR|GBP|IDR|MXN)\s+(\d[\d,]*(?:\.\d+)?)/g, (_, currency: keyof typeof rates, amount: string) =>
			formatUsd(convertAmount(currency, amount)),
		)
		.replace(/(\d[\d,]*(?:\.\d+)?)\s+\b(EUR|GBP|IDR|MXN)\b/g, (_, amount: string, currency: keyof typeof rates) =>
			formatUsd(convertAmount(currency, amount)),
		);
}

function convertAmount(currency: keyof typeof rates, amount: string): number {
	return Number(amount.replace(/,/g, '')) * rates[currency];
}

function formatUsd(amount: number): string {
	return `USD ${Math.round(amount).toLocaleString('en-US')}`;
}

function updateResultIntro(markdown: string): string {
	return markdown.replace(
		'Prices are total per person when already validated, otherwise quote status from the bulk evaluation.',
		`Prices are shown in USD per person when already validated, otherwise quote status from the bulk evaluation. Non-USD prices were converted with ${rateTimestamp} rates from ExchangeRate-API.`,
	);
}

function renderAudit(replacements: Replacement[]): string {
	const replacementRows = replacements
		.map(
			replacement =>
				`| ${escapeMarkdownCell(replacement.file)} | ${replacement.line} | ${escapeMarkdownCell(
					replacement.before,
				)} | ${escapeMarkdownCell(replacement.after)} |`,
		)
		.join('\n');

	return `# USD Price Conversion Audit

Generated: ${new Date().toISOString()}

Source: ${rateSource}
Rate timestamp: ${rateTimestamp}

| currency | USD conversion |
| --- | ---: |
| EUR | ${rates.EUR.toFixed(6)} |
| GBP | ${rates.GBP.toFixed(6)} |
| IDR | ${rates.IDR.toFixed(8)} |
| MXN | ${rates.MXN.toFixed(6)} |

| metric | count |
| --- | ---: |
| converted lines | ${replacements.length} |

## Converted Lines

| file | line | before | after |
| --- | ---: | --- | --- |
${replacementRows}
`;
}

function parseResultRows(markdown: string): ResultRow[] {
	const rows: ResultRow[] = [];
	for (const line of markdown.split('\n')) {
		if (!line.startsWith('| [')) {
			continue;
		}

		const link = parseMarkdownLink(splitMarkdownRow(line)[0] ?? '');
		if (!link) {
			continue;
		}

		rows.push({
			line,
			name: link.text,
			detailFile: link.href,
		});
	}
	return rows;
}

function splitMarkdownRow(line: string): string[] {
	const cells: string[] = [];
	let current = '';
	let escaped = false;

	for (let index = 1; index < line.length - 1; index++) {
		const character = line[index];

		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}

		if (character === '\\') {
			escaped = true;
			continue;
		}

		if (character === '|') {
			cells.push(current.trim());
			current = '';
			continue;
		}

		current += character;
	}

	cells.push(current.trim());
	return cells;
}

function parseMarkdownLink(value: string): { text: string; href: string } | undefined {
	const match = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
	if (!match?.[1] || !match[2]) {
		return undefined;
	}
	return {
		text: match[1].replace(/\\\|/g, '|'),
		href: match[2],
	};
}

function escapeMarkdownCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
