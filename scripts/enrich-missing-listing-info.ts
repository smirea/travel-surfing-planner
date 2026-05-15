#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import path from 'node:path';

interface ResultRow {
	line: string;
	cells: string[];
	name: string;
	detailFile: string;
}

interface Detail {
	filePath: string;
	markdown: string;
	fields: Map<string, string>;
	sources: string[];
}

interface FetchResult {
	url: string;
	ok: boolean;
	status?: number;
	html?: string;
	text?: string;
	error?: string;
}

interface Enrichment {
	file: string;
	name: string;
	website: string;
	pagesFetched: FetchResult[];
	updates: Record<string, string>;
	priceSnippets: string[];
	seasonSnippets: string[];
	housingSnippets: string[];
	lessonSnippets: string[];
}

const rootDir = path.resolve(import.meta.dir, '..');
const dataDir = path.join(rootDir, 'data');
const resultPath = path.join(dataDir, 'result.md');
const auditPath = path.join(dataDir, 'website_enrichment_audit.md');
const targetPeriod = 'Sep 20-Oct 31, 2026';

const vaguePattern =
	/quote required|not found|needs direct confirmation|see official pricing source|confirm exact|unknown \/ likely|possible \/ needs|unclear \/ likely|website evidence suggests/i;

const resultMarkdown = await Bun.file(resultPath).text();
const rows = parseResultRows(resultMarkdown);
const enrichments: Enrichment[] = [];

await runLimited(rows, 8, async row => {
	const detailPath = path.join(dataDir, row.detailFile);
	if (!existsSync(detailPath)) {
		return;
	}

	const detail = parseDetail(detailPath, await Bun.file(detailPath).text());
	if (!vaguePattern.test(row.line) && !vaguePattern.test(detail.markdown)) {
		return;
	}

	const website = detail.fields.get('Website');
	if (!website || website === '-' || /No website captured/i.test(website)) {
		return;
	}

	const enrichment = await enrichDetail(row, detail, website);
	enrichments.push(enrichment);

	if (Object.keys(enrichment.updates).length > 0) {
		const updated = writeFields(
			detail.markdown,
			enrichment.updates,
			enrichment.pagesFetched.map(page => page.url),
		);
		await Bun.write(detail.filePath, updated);
	}
});

await syncResultTable();
await Bun.write(auditPath, renderAudit(enrichments));

console.log(
	JSON.stringify(
		{
			rowsChecked: rows.length,
			sitesChecked: enrichments.length,
			filesUpdated: enrichments.filter(enrichment => Object.keys(enrichment.updates).length > 0).length,
			audit: path.relative(rootDir, auditPath),
		},
		null,
		2,
	),
);

async function enrichDetail(row: ResultRow, detail: Detail, website: string): Promise<Enrichment> {
	const pagesFetched = await fetchRelevantPages(website);
	const combinedText = pagesFetched
		.filter(page => page.ok && page.text)
		.map(page => page.text)
		.join('\n');

	const priceSnippets = extractPriceSnippets(combinedText);
	const seasonSnippets = extractSnippets(
		combinedText,
		/\b(year[- ]?round|all year|every day|daily|open daily|available daily|open all year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|september|october|season)\b/i,
	);
	const housingSnippets = extractSnippets(
		combinedText,
		/\b(accommodation|accomodation|room|hostel|hotel|house|villa|stay|breakfast|surf camp|surfcamp|camp package)\b/i,
	);
	const lessonSnippets = extractSnippets(
		combinedText,
		/\b(beginner|beginners|first[- ]timer|learn to surf|all levels|private lesson|group lesson|surf lesson|coaching|instructor)\b/i,
	);

	const updates: Record<string, string> = {};
	const currentPrice = detail.fields.get('Price') ?? '';
	const currentHousing = detail.fields.get('Housing') ?? '';
	const currentPeriod = detail.fields.get('Period fit') ?? '';
	const currentLessons = detail.fields.get('Lessons') ?? '';
	const currentDuration = detail.fields.get('Duration') ?? '';

	const price = summarizePrice(priceSnippets);
	if (price && shouldReplace(currentPrice)) {
		updates.Price = price;
	}

	const housing = summarizeHousing(housingSnippets, combinedText);
	if (housing && shouldReplace(currentHousing)) {
		updates.Housing = housing;
	}

	const period = summarizePeriod(seasonSnippets, combinedText);
	if (period && shouldReplace(currentPeriod)) {
		updates['Period fit'] = period;
	}

	const lessons = summarizeLessons(lessonSnippets, combinedText);
	if (lessons && shouldReplace(currentLessons)) {
		updates.Lessons = lessons;
	}

	const duration = summarizeDuration(combinedText);
	if (duration && shouldReplace(currentDuration)) {
		updates.Duration = duration;
	}

	if (Object.keys(updates).length > 0) {
		updates.Notes = summarizeNotes(row, detail);
	} else if (/Enriched from official website|Evidence:/i.test(detail.fields.get('Notes') ?? '')) {
		updates.Notes = summarizeNotes(row, detail);
	}

	return {
		file: path.relative(rootDir, detail.filePath),
		name: row.name,
		website,
		pagesFetched,
		updates,
		priceSnippets,
		seasonSnippets,
		housingSnippets,
		lessonSnippets,
	};
}

async function fetchRelevantPages(website: string): Promise<FetchResult[]> {
	const first = await fetchPage(website);
	const pages = [first];
	if (!first.html) {
		return pages;
	}

	const links = extractLinks(first.html, first.url)
		.filter(url => sameSite(url, first.url))
		.filter(url =>
			/price|pricing|rate|lesson|surf|camp|package|accommodation|room|stay|book|faq|contact/i.test(
				new URL(url).pathname,
			),
		)
		.filter(isUsefulSource)
		.slice(0, 8);

	for (const link of links) {
		if (pages.some(page => normalizeUrl(page.url) === normalizeUrl(link))) {
			continue;
		}
		pages.push(await fetchPage(link));
	}

	return pages;
}

async function fetchPage(url: string): Promise<FetchResult> {
	try {
		const response = await fetch(url, {
			headers: {
				'user-agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
				accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
			signal: AbortSignal.timeout(8000),
			redirect: 'follow',
		});
		const contentType = response.headers.get('content-type') ?? '';
		const body = contentType.includes('text') || contentType.includes('html') ? await response.text() : '';
		return {
			url: response.url || url,
			ok: response.ok,
			status: response.status,
			html: body || undefined,
			text: body ? htmlToText(body) : undefined,
		};
	} catch (error) {
		return {
			url,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function htmlToText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&euro;/g, ' EUR ')
		.replace(/&#8364;/g, ' EUR ')
		.replace(/&pound;/g, ' GBP ')
		.replace(/&#36;/g, ' USD ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractLinks(htmlText: string, baseUrl: string): string[] {
	const original = htmlText;
	const links: string[] = [];
	for (const match of original.matchAll(/href=["']([^"']+)["']/gi)) {
		const href = match[1];
		if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
			continue;
		}
		try {
			links.push(new URL(href, baseUrl).toString());
		} catch {
			continue;
		}
	}
	return [...new Set(links)];
}

function extractPriceSnippets(text: string): string[] {
	const moneyPattern =
		/(?:USD|AUD|EUR|GBP|IDR|MAD|BRL|LKR|Rs\.?|US\$|AU\$|R\$|\$|€|£)\s?\d[\d.,]*(?:\s?[-–]\s?(?:USD|AUD|EUR|GBP|IDR|MAD|BRL|LKR|Rs\.?|US\$|AU\$|R\$|\$|€|£)?\s?\d[\d.,]*)?|\d[\d.,]*\s?(?:USD|AUD|EUR|GBP|IDR|MAD|BRL|LKR|Rs\.?|dollars|euros|€|£)/gi;
	const snippets: string[] = [];
	for (const match of text.matchAll(moneyPattern)) {
		const index = match.index ?? 0;
		const snippet = cleanSnippet(text.slice(Math.max(0, index - 140), Math.min(text.length, index + 180)));
		if (/\b(surf|lesson|camp|package|beginner|group|private|accommodation|room|week|day|night)\b/i.test(snippet)) {
			snippets.push(snippet);
		}
	}
	return uniqueSnippets(snippets).slice(0, 5);
}

function extractSnippets(text: string, pattern: RegExp): string[] {
	const snippets: string[] = [];
	for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
		const index = match.index ?? 0;
		snippets.push(cleanSnippet(text.slice(Math.max(0, index - 120), Math.min(text.length, index + 180))));
	}
	return uniqueSnippets(snippets).slice(0, 4);
}

function summarizePrice(snippets: string[]): string | undefined {
	if (snippets.length === 0) {
		return undefined;
	}

	const compact = snippets
		.map(snippet => snippet.replace(/\s+/g, ' '))
		.find(snippet => snippet.length <= 260 && /\d/.test(snippet));
	return compact ? `Official site pricing found in accessible page text: ${compact}` : undefined;
}

function summarizeHousing(snippets: string[], text: string): string | undefined {
	if (
		/\b(accommodation|room|hostel|hotel|villa|surf house|guesthouse|breakfast|7 nights|14 nights|surf camp)\b/i.test(
			text,
		)
	) {
		const basis = snippets[0] ? conciseBasis(snippets[0]) : 'official site references rooms/stay/camp accommodation';
		return `yes / ${basis}.`;
	}
	if (/\b(surf lessons?|private lesson|group lesson|board rental)\b/i.test(text)) {
		return 'no package found on official site; appears lessons/rentals-only from accessible pages.';
	}
	return undefined;
}

function summarizePeriod(snippets: string[], text: string): string | undefined {
	if (/\b(year[- ]?round|all year|open all year|every day|daily|open daily|available daily)\b/i.test(text)) {
		return `Likely available during ${targetPeriod}; official site describes recurring daily/year-round operation.`;
	}
	if (/\b(september|october)\b/i.test(text)) {
		return `Target-period evidence found for ${targetPeriod} in accessible official-site text.`;
	}
	return undefined;
}

function summarizeLessons(snippets: string[], text: string): string | undefined {
	const beginner = /\b(beginner|beginners|first[- ]timer|learn to surf|all levels)\b/i.test(text);
	const englishLikely = countAsciiWords(text) > 800;
	if (beginner) {
		return `Official site supports beginner/all-level surf instruction${englishLikely ? ' and is published in English' : ''}.`;
	}
	if (/\b(surf lesson|private lesson|group lesson|coaching|instructor)\b/i.test(text)) {
		return 'Official site confirms surf lessons/coaching; beginner suitability still not explicit in accessible text.';
	}
	return undefined;
}

function summarizeDuration(text: string): string | undefined {
	const matches = [
		...text.matchAll(
			/\b(?:\d+\s?(?:day|days|night|nights|week|weeks)|weekly|2\s?hours?|two\s?hours?|90\s?minutes|1\.5\s?hours?)\b.{0,120}\b(?:surf|lesson|camp|package|course)\b|\b(?:surf|lesson|camp|package|course)\b.{0,120}\b(?:\d+\s?(?:day|days|night|nights|week|weeks)|weekly|2\s?hours?|two\s?hours?|90\s?minutes|1\.5\s?hours?)\b/gi,
		),
	];
	const snippet = matches[0]?.[0];
	return snippet ? cleanSnippet(`Official site duration clue: ${snippet}`).slice(0, 180) : undefined;
}

function summarizeNotes(row: ResultRow, detail: Detail): string {
	const current = detail.fields.get('Notes') ?? row.cells[7] ?? '';
	const base = current.replace(/\s*Enriched from official website\..*$/i, '').trim();
	return cleanSnippet(
		`${base} Official site checked; updated fields reflect accessible website text, with remaining quote/booking gaps left explicit.`,
	).slice(0, 360);
}

async function syncResultTable(): Promise<void> {
	const current = await Bun.file(resultPath).text();
	const lines = current.split('\n');
	const resolvedLines: string[] = [];
	for (const line of lines) {
		if (!line.startsWith('| [')) {
			resolvedLines.push(line);
			continue;
		}
		const cells = splitMarkdownRow(line);
		const link = parseMarkdownLink(cells[0] ?? '');
		if (!link) {
			resolvedLines.push(line);
			continue;
		}
		const detailPath = path.join(dataDir, link.href);
		if (!existsSync(detailPath)) {
			resolvedLines.push(line);
			continue;
		}
		const detail = parseDetail(detailPath, await Bun.file(detailPath).text());
		cells[4] = detail.fields.get('Period fit') ?? cells[4] ?? '';
		cells[5] = detail.fields.get('Price') ?? cells[5] ?? '';
		cells[6] = detail.fields.get('Housing') ?? cells[6] ?? '';
		cells[7] = detail.fields.get('Notes') ?? cells[7] ?? '';
		resolvedLines.push(`| ${cells.map(escapeMarkdownCell).join(' | ')} |`);
	}

	await Bun.write(resultPath, resolvedLines.join('\n'));
}

function parseDetail(filePath: string, markdown: string): Detail {
	const fields = new Map<string, string>();
	const sources: string[] = [];
	let inSources = false;
	for (const line of markdown.split('\n')) {
		const field = line.match(/^([^:\n]+):\s*(.*)$/);
		if (field?.[1] && field[2] !== undefined && !line.startsWith('http')) {
			fields.set(field[1], field[2]);
		}
		if (line.trim() === 'Sources:') {
			inSources = true;
			continue;
		}
		if (inSources && line.startsWith('- ')) {
			sources.push(line.slice(2).trim());
		}
	}
	return { filePath, markdown, fields, sources };
}

function writeFields(markdown: string, updates: Record<string, string>, sources: string[]): string {
	let updated = removeLowValueSources(markdown);
	for (const [label, value] of Object.entries(updates)) {
		updated = replaceField(updated, label, value);
	}
	const sourceLines = sources.filter(isUsefulSource).map(source => `- ${source}`);
	for (const sourceLine of sourceLines) {
		if (!updated.includes(sourceLine)) {
			updated = updated.replace(/(Sources:\n)/, `$1${sourceLine}\n`);
		}
	}
	return updated;
}

function replaceField(markdown: string, label: string, value: string): string {
	const linePattern = new RegExp(`^${escapeRegExp(label)}:.*$`, 'm');
	if (linePattern.test(markdown)) {
		return markdown.replace(linePattern, `${label}: ${escapeMarkdownLine(value)}`);
	}
	return markdown.replace(/\nSources:\n/, `\n${label}: ${escapeMarkdownLine(value)}\n\nSources:\n`);
}

function renderAudit(enrichments: Enrichment[]): string {
	const updated = enrichments.filter(enrichment => Object.keys(enrichment.updates).length > 0);
	const failed = enrichments.filter(enrichment => enrichment.pagesFetched.every(page => !page.ok));
	const updatedRows = updated
		.map(
			enrichment =>
				`| ${escapeMarkdownCell(enrichment.file)} | ${escapeMarkdownCell(enrichment.name)} | ${escapeMarkdownCell(
					Object.keys(enrichment.updates).join(', '),
				)} | ${escapeMarkdownCell(enrichment.website)} |`,
		)
		.join('\n');

	const failedRows = failed
		.map(
			enrichment =>
				`| ${escapeMarkdownCell(enrichment.file)} | ${escapeMarkdownCell(enrichment.name)} | ${escapeMarkdownCell(enrichment.website)} |`,
		)
		.join('\n');

	return `# Website Enrichment Audit

Generated: ${new Date().toISOString()}

| metric | count |
| --- | ---: |
| result rows | ${parseResultRows(resultMarkdown).length} |
| sites checked | ${enrichments.length} |
| files updated | ${updated.length} |
| sites with no successful fetch | ${failed.length} |

## Updated Listings

| file | listing | updated fields | website |
| --- | --- | --- | --- |
${updatedRows}

## Fetch Failures

| file | listing | website |
| --- | --- | --- |
${failedRows}
`;
}

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
			line,
			cells,
			name: link.text,
			detailFile: link.href,
		});
	}
	return rows;
}

async function runLimited<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from({ length: concurrency }, async () => {
		while (nextIndex < items.length) {
			const item = items[nextIndex];
			nextIndex += 1;
			if (item !== undefined) {
				await worker(item);
			}
		}
	});
	await Promise.all(workers);
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

function isVague(value: string): boolean {
	return !value || vaguePattern.test(value);
}

function shouldReplace(value: string): boolean {
	return (
		isVague(value) ||
		/Enriched from official website|Evidence:|Official site duration clue|Likely available during|Official site pricing found/i.test(
			value,
		)
	);
}

function conciseBasis(snippet: string): string {
	if (/\bsurf and stay\b/i.test(snippet)) {
		return 'official site references Surf and Stay';
	}
	if (/\b(accommodation|room|hostel|hotel|villa|guesthouse)\b/i.test(snippet)) {
		return 'official site references accommodation/rooms';
	}
	if (/\b(7 nights|14 nights|breakfast|surf camp|surfcamp)\b/i.test(snippet)) {
		return 'official site references camp stay inclusions';
	}
	return 'official site references stay or camp accommodation';
}

function removeLowValueSources(markdown: string): string {
	return markdown
		.split('\n')
		.filter(line => !line.startsWith('- ') || isUsefulSource(line.slice(2).trim()))
		.join('\n');
}

function isUsefulSource(source: string): boolean {
	return !/wp-json|oembed|\/feed\/?$|comments\/feed|xmlrpc|favicon|wp-content|wp-includes|\.(?:css|js|ico|png|jpe?g|gif|svg|woff2?)(?:\?|$)/i.test(
		source,
	);
}

function sameSite(left: string, right: string): boolean {
	try {
		const leftUrl = new URL(left);
		const rightUrl = new URL(right);
		return leftUrl.hostname.replace(/^www\./, '') === rightUrl.hostname.replace(/^www\./, '');
	} catch {
		return false;
	}
}

function normalizeUrl(url: string): string {
	return url.replace(/\/$/, '');
}

function cleanSnippet(value: string): string {
	return value
		.replace(/Cookie Consent[\s\S]*$/i, '')
		.replace(/\s+/g, ' ')
		.replace(/\|/g, '/')
		.trim();
}

function uniqueSnippets(snippets: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const snippet of snippets) {
		const normalized = snippet.toLowerCase().slice(0, 120);
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		unique.push(snippet);
	}
	return unique;
}

function countAsciiWords(text: string): number {
	const matches = text.match(/\b[a-z]{3,}\b/gi);
	return matches?.length ?? 0;
}

function escapeMarkdownCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeMarkdownLine(value: string): string {
	return value.replace(/\n/g, ' ');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
