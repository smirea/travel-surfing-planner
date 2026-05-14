#!/usr/bin/env bun
import path from 'node:path';

interface Candidate {
	country: string;
	city: string;
	name: string;
	placeId?: string;
	googleMaps?: string;
}

interface ResultRow {
	lineIndex: number;
	line: string;
	name: string;
	country: string;
	city: string;
	rating: string;
	period: string;
	price: string;
	housing: string;
	notes: string;
	detailFile: string;
	googleMapsId: string;
}

interface ManualPlace {
	country: string;
	name: string;
	placeId: string;
}

const rootDir = path.resolve(import.meta.dir, '..');
const dataDir = path.join(rootDir, 'data');
const resultPath = path.join(dataDir, 'result.md');
const auditPath = path.join(dataDir, 'google_maps_id_audit.md');
const rawPath = path.join(dataDir, 'raw/google-places-candidates.json');

const manualPlaces: ManualPlace[] = [
	{
		country: 'Morocco',
		name: 'Chill Surfer Hostel',
		placeId: 'ChIJ-7kyntyzsw0RC3nUuRPGxPE',
	},
	{
		country: 'Portugal',
		name: 'Ericeira Surf Camp',
		placeId: 'ChIJIbfLaQsnHw0RzSpdoU2TKq4',
	},
	{
		country: 'Indonesia',
		name: 'Padang Padang Surf Camp',
		placeId: 'ChIJw6EjDExF0i0RSs_qNonm50k',
	},
	{
		country: 'Sri Lanka',
		name: 'Chill & Surf Weligama',
		placeId: 'ChIJWXe7IQAV4ToRughDroSCclU',
	},
];

const raw = JSON.parse(await Bun.file(rawPath).text()) as { candidates: Candidate[] };
const resultMarkdown = await Bun.file(resultPath).text();
const placeIds = buildPlaceIdIndex(raw.candidates, manualPlaces);
const rows = parseResultRows(resultMarkdown, placeIds);
const deduped = dedupeRows(rows);

for (const row of deduped.keptRows) {
	const detailPath = path.join(dataDir, row.detailFile);
	const markdown = await Bun.file(detailPath).text();
	await Bun.write(detailPath, stampMarkdown(markdown, row.googleMapsId));
}

if (deduped.removedRows.length) {
	await Bun.write(resultPath, renderDedupedResult(resultMarkdown, deduped.keptRows, deduped.removedRows));
}

await Bun.write(auditPath, renderAudit(rows, deduped));

console.log(
	JSON.stringify(
		{
			resultRowsChecked: rows.length,
			uniqueGoogleMapsIds: new Set(rows.map(row => row.googleMapsId)).size,
			duplicateRowsRemoved: deduped.removedRows.length,
			detailFilesStamped: deduped.keptRows.length,
			audit: path.relative(rootDir, auditPath),
		},
		null,
		2,
	),
);

function buildPlaceIdIndex(candidates: Candidate[], manual: ManualPlace[]): Map<string, string> {
	const index = new Map<string, string>();

	for (const candidate of candidates) {
		if (!candidate.placeId) {
			continue;
		}
		index.set(candidateKey(candidate.country, candidate.name), candidate.placeId);
	}

	for (const place of manual) {
		index.set(candidateKey(place.country, place.name), place.placeId);
	}

	return index;
}

function parseResultRows(markdown: string, placeIds: Map<string, string>): ResultRow[] {
	const rows: ResultRow[] = [];
	const missing: string[] = [];

	for (const [lineIndex, line] of markdown.split('\n').entries()) {
		if (!line.startsWith('| [')) {
			continue;
		}

		const cells = splitMarkdownRow(line);
		const link = parseMarkdownLink(cells[0] ?? '');
		if (!link) {
			continue;
		}

		const country = cells[1] ?? '';
		const googleMapsId = placeIds.get(candidateKey(country, link.text));
		if (!googleMapsId) {
			missing.push(`${country} :: ${link.text} :: ${link.href}`);
			continue;
		}

		rows.push({
			lineIndex,
			line,
			name: link.text,
			detailFile: link.href,
			country,
			city: cells[2] ?? '',
			rating: cells[3] ?? '',
			period: cells[4] ?? '',
			price: cells[5] ?? '',
			housing: cells[6] ?? '',
			notes: cells[7] ?? '',
			googleMapsId,
		});
	}

	if (missing.length) {
		throw new Error(`Missing Google Maps IDs for ${missing.length} result rows:\n${missing.join('\n')}`);
	}

	return rows;
}

function dedupeRows(rows: ResultRow[]): { keptRows: ResultRow[]; removedRows: ResultRow[] } {
	const keptById = new Map<string, ResultRow>();
	const removedRows: ResultRow[] = [];

	for (const row of rows) {
		const existing = keptById.get(row.googleMapsId);
		if (!existing) {
			keptById.set(row.googleMapsId, row);
			continue;
		}

		const winner = scoreRow(row) > scoreRow(existing) ? row : existing;
		const loser = winner === row ? existing : row;
		keptById.set(row.googleMapsId, winner);
		removedRows.push(loser);
	}

	const keptIndexes = new Set([...keptById.values()].map(row => row.lineIndex));
	return {
		keptRows: rows.filter(row => keptIndexes.has(row.lineIndex)),
		removedRows,
	};
}

function scoreRow(row: ResultRow): number {
	let score = 0;
	if (!/catch-up add/i.test(row.notes)) score += 8;
	if (!/quote required|not found|needs direct confirmation/i.test(row.price)) score += 4;
	if (!/needs direct confirmation/i.test(row.period)) score += 2;
	if (/yes/i.test(row.housing)) score += 1;
	return score;
}

function stampMarkdown(markdown: string, googleMapsId: string): string {
	const withoutOldStamp = markdown.replace(/^<!-- google_maps_id: [^>]+ -->\n+/i, '');
	return `<!-- google_maps_id: ${googleMapsId} -->\n${withoutOldStamp.trimStart()}`;
}

function renderDedupedResult(markdown: string, keptRows: ResultRow[], removedRows: ResultRow[]): string {
	const keptIndexes = new Set(keptRows.map(row => row.lineIndex));
	const removedIndexes = new Set(removedRows.map(row => row.lineIndex));
	const lines = markdown.split('\n').filter((_, index) => !removedIndexes.has(index) || keptIndexes.has(index));
	return `${lines.join('\n').trimEnd()}\n`;
}

function renderAudit(rows: ResultRow[], deduped: { keptRows: ResultRow[]; removedRows: ResultRow[] }): string {
	const generatedAt = new Date().toISOString();
	const duplicateGroups = groupDuplicates(rows);
	const duplicateRows = duplicateGroups
		.map(group => {
			const items = group.map(row => `  - ${row.country} | ${row.name} | ${row.detailFile}`).join('\n');
			return `- ${group[0]?.googleMapsId}\n${items}`;
		})
		.join('\n');

	return `# Google Maps ID Audit

Generated: ${generatedAt}

Each school detail file referenced by \`data/result.md\` starts with a \`google_maps_id\` HTML comment. This is the canonical dedupe key because names and URLs can vary while the Google Places ID identifies one place.

| metric | count |
| --- | ---: |
| result rows checked | ${rows.length} |
| unique Google Maps IDs before dedupe | ${new Set(rows.map(row => row.googleMapsId)).size} |
| duplicate ID groups found | ${duplicateGroups.length} |
| duplicate result rows removed | ${deduped.removedRows.length} |
| detail files stamped | ${deduped.keptRows.length} |

## Duplicate Groups

${duplicateRows || 'None.'}
`;
}

function groupDuplicates(rows: ResultRow[]): ResultRow[][] {
	const byId = new Map<string, ResultRow[]>();
	for (const row of rows) {
		byId.set(row.googleMapsId, [...(byId.get(row.googleMapsId) ?? []), row]);
	}
	return [...byId.values()].filter(group => group.length > 1);
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

function candidateKey(country: string, name: string): string {
	return `${normalizeText(country)}\0${compactName(name)}`;
}

function compactName(value: string): string {
	return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/&amp;/g, '&')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}
