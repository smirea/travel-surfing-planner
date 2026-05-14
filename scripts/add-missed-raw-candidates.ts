#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import path from 'node:path';

interface Candidate {
	sourceQuery?: string;
	country: string;
	city: string;
	name: string;
	rating?: number;
	reviewCount?: number;
	website?: string | null;
	googleMaps?: string;
	placeId?: string;
}

interface ResultRow {
	name: string;
	country: string;
	city: string;
	rating: string;
	period: string;
	price: string;
	housing: string;
	notes: string;
	detailFile: string;
}

const rootDir = path.resolve(import.meta.dir, '..');
const dataDir = path.join(rootDir, 'data');
const resultPath = path.join(dataDir, 'result.md');
const evaluationPath = path.join(dataDir, 'full_evaluation.md');
const auditPath = path.join(dataDir, 'missed_candidate_audit.md');
const rawPath = path.join(dataDir, 'raw/google-places-candidates.json');

const raw = JSON.parse(await Bun.file(rawPath).text()) as { candidates: Candidate[] };
const resultMarkdown = await Bun.file(resultPath).text();
const evaluationMarkdown = await Bun.file(evaluationPath).text();
const existingRows = parseResultRows(resultMarkdown);
const existingKeys = new Set(existingRows.map(row => candidateKey(row.country, row.name)));
const existingFiles = new Set(existingRows.map(row => row.detailFile));
const usedFiles = new Set([...existingFiles]);
const generatedAt = new Date().toISOString();
const missed = raw.candidates.filter(candidate => !existingKeys.has(candidateKey(candidate.country, candidate.name)));
const additions = missed.map(candidate => candidateToResultRow(candidate, usedFiles));

if (!additions.length) {
	console.log(
		JSON.stringify(
			{
				rawCandidates: raw.candidates.length,
				existingRows: existingRows.length,
				addedRows: 0,
				resultRows: existingRows.length,
				message: 'No missed raw candidates remain.',
			},
			null,
			2,
		),
	);
	process.exit(0);
}

for (const addition of additions) {
	await Bun.write(path.join(dataDir, addition.detailFile), renderDetail(addition));
}

await Bun.write(resultPath, renderResult(resultMarkdown, additions));
await Bun.write(evaluationPath, renderEvaluation(evaluationMarkdown, additions));
await Bun.write(auditPath, renderAudit(raw.candidates, existingRows, additions, generatedAt));

console.log(
	JSON.stringify(
		{
			rawCandidates: raw.candidates.length,
			existingRows: existingRows.length,
			addedRows: additions.length,
			resultRows: existingRows.length + additions.length,
			audit: path.relative(rootDir, auditPath),
		},
		null,
		2,
	),
);

function parseResultRows(markdown: string): ResultRow[] {
	const rows: ResultRow[] = [];
	for (const line of markdown.split('\n')) {
		if (!line.startsWith('| [')) {
			continue;
		}

		const cells = splitMarkdownRow(line);
		const link = parseMarkdownLink(cells[0] ?? '');
		if (!link) {
			continue;
		}

		rows.push({
			name: link.text,
			detailFile: link.href,
			country: cells[1] ?? '',
			city: cells[2] ?? '',
			rating: cells[3] ?? '',
			period: cells[4] ?? '',
			price: cells[5] ?? '',
			housing: cells[6] ?? '',
			notes: cells[7] ?? '',
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

function candidateToResultRow(candidate: Candidate, usedFiles: Set<string>): ResultRow {
	const detailFile = uniqueDetailFile(candidate, usedFiles);
	const rating = formatRating(candidate);
	const housing = inferHousing(candidate);
	const note =
		'Catch-up add from raw/country discovery; missed by the prior top-school evaluation. Keep included unless direct checking finds no beginner English surf instruction in the target period.';

	return {
		name: candidate.name,
		country: candidate.country,
		city: candidate.city,
		rating,
		period: 'Needs direct confirmation for Sep 20-Oct 31, 2026',
		price: 'Quote required / not found in stored research',
		housing,
		notes: note,
		detailFile,
	};
}

function uniqueDetailFile(candidate: Candidate, usedFiles: Set<string>): string {
	const base = `${slugify(candidate.country)}__${slugify(candidate.name)}`;
	let detailFile = `${base}.md`;
	let suffix = 2;
	while (usedFiles.has(detailFile) || existsSync(path.join(dataDir, detailFile))) {
		detailFile = `${base}-${suffix}.md`;
		suffix++;
	}
	usedFiles.add(detailFile);
	return detailFile;
}

function renderDetail(row: ResultRow): string {
	const candidate = raw.candidates.find(
		item => candidateKey(item.country, item.name) === candidateKey(row.country, row.name),
	);
	const googleMapsId = candidate?.placeId ?? 'unknown';
	const website = candidate?.website || 'No website captured in Google Places result.';
	const maps = candidate?.googleMaps || googleMapsSearchUrl(row.name, row.city, row.country);
	const sources = [candidate?.website, maps].filter(Boolean);

	return [
		`<!-- google_maps_id: ${googleMapsId} -->`,
		`# ${row.city}, ${row.country}: ${row.name}`,
		'',
		'Duration: Needs direct confirmation. This was a missed raw Google Places discovery candidate, not a previously rejected school.',
		'',
		`Price: ${row.price}`,
		'',
		`Website: ${website}`,
		'',
		`Google Maps: ${maps}`,
		'',
		'Tripadvisor: -',
		'',
		`Housing: ${row.housing}`,
		'',
		`Rating: ${row.rating}`,
		'',
		`Lessons: Raw discovery matched "${candidate?.sourceQuery ?? 'beginner surf lessons / surf camp search'}". Direct confirmation is still needed for complete-beginner English instruction.`,
		'',
		`Period fit: ${row.period}. It remains included because the stored data has no affirmative evidence that it does not offer beginner English surf instruction during the target period.`,
		'',
		`Things to do around: ${row.city}; not deeply researched in this catch-up pass.`,
		'',
		`Notes: ${row.notes}`,
		'',
		'Sources:',
		...sources.map(source => `- ${source}`),
		'',
	].join('\n');
}

function renderResult(markdown: string, additions: ResultRow[]): string {
	if (!additions.length) {
		return markdown;
	}

	const rows = additions
		.sort((left, right) => {
			const country = left.country.localeCompare(right.country);
			if (country) return country;
			const rating = parseRatingValue(right.rating) - parseRatingValue(left.rating);
			if (rating) return rating;
			return left.name.localeCompare(right.name);
		})
		.map(row => resultRowMarkdown(row))
		.join('\n');

	const updated = markdown.replace(
		'Rows with missing price/date details remain included and are marked for direct confirmation.',
		'Rows with missing price/date details remain included and are marked for direct confirmation. This version also adds raw/country discovery candidates that were missed by the previous top-school evaluation pass.',
	);
	return `${updated.trimEnd()}\n${rows}\n`;
}

function resultRowMarkdown(row: ResultRow): string {
	const link = `[${escapeMarkdownCell(row.name)}](${row.detailFile})`;
	const cells = [row.country, row.city, row.rating, row.period, row.price, row.housing, row.notes];
	return [link, ...cells.map(value => escapeMarkdownCell(value))].join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function renderEvaluation(markdown: string, additions: ResultRow[]): string {
	if (!additions.length) {
		return markdown;
	}

	const countTablePattern = /## Counts\n\n\| decision \| count \|\n\| --- \| ---: \|\n(?:\| .+\|\n)+/;
	const existingCountRows = [...markdown.matchAll(/^\| ([^|]+) \| +(\d+) \|$/gm)].map(match => ({
		decision: match[1]?.trim() ?? '',
		count: Number(match[2] ?? 0),
	}));
	const counts = new Map(existingCountRows.map(row => [row.decision, row.count]));
	counts.set('included_missed_raw_candidate_needs_confirmation', additions.length);
	const countRows = [...counts.entries()]
		.filter(([decision]) => decision && decision !== 'decision')
		.map(([decision, count]) => `| ${decision} | ${count} |`)
		.join('\n');
	const withCounts = markdown.replace(
		countTablePattern,
		`## Counts\n\n| decision | count |\n| --- | ---: |\n${countRows}\n`,
	);
	const rows = additions
		.sort((left, right) => left.country.localeCompare(right.country) || left.name.localeCompare(right.name))
		.map(
			row =>
				`| included_missed_raw_candidate_needs_confirmation | ${escapeMarkdownCell(row.country)} | ${escapeMarkdownCell(row.city)} | ${escapeMarkdownCell(row.name)} | raw/country discovery candidate missed by previous top-school evaluation; no affirmative exclusion evidence in stored data | [detail](${row.detailFile}) |`,
		)
		.join('\n');
	return `${withCounts.trimEnd()}\n${rows}\n`;
}

function renderAudit(
	candidates: Candidate[],
	existingRows: ResultRow[],
	additions: ResultRow[],
	generatedAt: string,
): string {
	const countryCounts = countBy(additions, row => row.country);
	const rows = [...countryCounts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([country, count]) => `| ${country} | ${count} |`)
		.join('\n');
	const topMisses = [...additions]
		.sort((left, right) => parseRatingValue(right.rating) - parseRatingValue(left.rating))
		.slice(0, 25)
		.map(
			row =>
				`| ${escapeMarkdownCell(row.country)} | ${escapeMarkdownCell(row.city)} | [${escapeMarkdownCell(row.name)}](${row.detailFile}) | ${escapeMarkdownCell(row.rating)} |`,
		)
		.join('\n');

	return `# Missed Candidate Audit

Generated: ${generatedAt}

This audit checks raw Google Places candidates from \`data/raw/google-places-candidates.json\` against \`data/result.md\`. The correction rule is that a discovered school stays included unless there is affirmative evidence that it does not offer beginner English surf instruction during September 20-October 31, 2026.

| metric | count |
| --- | ---: |
| raw Google Places candidates | ${candidates.length} |
| result rows before catch-up | ${existingRows.length} |
| missed raw candidates added | ${additions.length} |
| result rows after catch-up | ${existingRows.length + additions.length} |

## Added By Country

| country | added |
| --- | ---: |
${rows}

## Highest-Rated Added Candidates

| country | city | school | rating |
| --- | --- | --- | --- |
${topMisses}

## Notes

- Added rows are marked as direct-confirmation options, not as fully priced recommendations.
- No added row is treated as rejected unless a future direct check finds affirmative no-beginner, no-English, or no-period evidence.
- Countries that previously had no final rows now have candidates in the results, including South Africa, Dominican Republic, Maldives, New Zealand, and Panama.
`;
}

function countBy<T>(items: T[], read: (item: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) {
		const key = read(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function inferHousing(candidate: Candidate): string {
	const text = `${candidate.name} ${candidate.website ?? ''}`.toLowerCase();
	if (/\b(camp|resort|retreat|hostel|hotel|house|lodge|stay|villa|yoga)\b/.test(text)) {
		return 'possible / needs direct confirmation';
	}
	return 'unknown / likely lessons-only unless confirmed';
}

function formatRating(candidate: Candidate): string {
	if (candidate.rating == null) {
		return candidate.reviewCount ? `Google review count ${candidate.reviewCount}` : 'Google rating not captured';
	}
	if (candidate.reviewCount == null) {
		return `${candidate.rating} Google`;
	}
	return `${candidate.rating} Google (${candidate.reviewCount})`;
}

function parseRatingValue(value: string): number {
	const match = value.match(/\d+(?:\.\d+)?/);
	return match?.[0] ? Number(match[0]) : 0;
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

function slugify(value: string): string {
	return normalizeText(value)
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 96);
}

function escapeMarkdownCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function googleMapsSearchUrl(name: string, city: string, country: string): string {
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
		[name, city, country].filter(Boolean).join(' '),
	)}`;
}
