import { existsSync } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface ResultRow {
	id: string;
	name: string;
	country: string;
	city: string;
	rating: string;
	period: string;
	price: string;
	withHousing: string;
	notes: string;
	ratingValue: number | undefined;
	websiteUrl: string | undefined;
	googleMapsUrl: string;
	tripAdvisorUrl: string | undefined;
	detailFile: string;
	detail: DetailData;
}

interface PlaceCandidate {
	name: string;
	country: string;
	city?: string;
	googleMaps?: string;
	website?: string;
}

interface DetailData {
	title: string;
	image?: { alt: string; url: string };
	fields: Array<{ label: string; value: string }>;
	sources: string[];
	raw: string;
}

interface Args {
	port: number;
	open: boolean;
}

const args = (await yargs(hideBin(process.argv))
	.scriptName('travel-surfing-planner')
	.option('port', {
		type: 'number',
		default: Number(process.env.PORT ?? 6174),
		describe: 'HTTP port to serve the results viewer on.',
	})
	.option('open', {
		type: 'boolean',
		default: true,
		describe: 'Open the viewer in the default browser.',
	})
	.strict()
	.parseAsync()) as Args;

const rootDir = path.resolve(import.meta.dir, '..');

const server = Bun.serve({
	port: args.port,
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/') {
			return htmlResponse(renderPage());
		}

		if (url.pathname === '/api/results') {
			return jsonResponse(await readResults());
		}

		if (url.pathname === '/favicon.svg') {
			return fileResponse(path.join(rootDir, 'public/favicon.svg'), 'image/svg+xml; charset=utf-8');
		}

		return new Response('Not found', { status: 404 });
	},
});

const viewerUrl = `http://localhost:${server.port}`;
console.log(`Surf trip results: ${viewerUrl}`);

if (args.open) {
	Bun.spawn(['open', viewerUrl], {
		stdout: 'ignore',
		stderr: 'ignore',
	});
}

function htmlResponse(body: string): Response {
	return new Response(body, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
		},
	});
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}

async function fileResponse(filePath: string, contentType: string): Promise<Response> {
	return new Response(await Bun.file(filePath).arrayBuffer(), {
		headers: {
			'content-type': contentType,
			'cache-control': 'public, max-age=86400',
		},
	});
}

async function readResults(): Promise<ResultRow[]> {
	const resultPath = path.join(rootDir, 'data/result.md');
	const resultMarkdown = await Bun.file(resultPath).text();
	const tableLines = resultMarkdown.split('\n').filter(line => line.startsWith('| ['));
	const placeCandidates = await readPlaceCandidates();

	const results: ResultRow[] = [];
	for (const line of tableLines) {
		const cells = splitMarkdownRow(line);
		const nameCell = cells[0] ?? '';
		const link = parseMarkdownLink(nameCell);
		if (!link) {
			continue;
		}

		const detailFile = link.href;
		const detailPath = path.join(rootDir, 'data', detailFile);
		const detail = existsSync(detailPath)
			? parseDetailMarkdown(await Bun.file(detailPath).text())
			: {
					title: link.text,
					fields: [],
					sources: [],
					raw: `Missing detail file: ${detailFile}`,
				};
		const country = cells[1] ?? '';
		const city = cells[2] ?? '';
		const placeCandidate = findPlaceCandidate(placeCandidates, link.text, country, city);
		const googleMapsUrl = placeCandidate?.googleMaps ?? googleMapsSearchUrl(link.text, city, country);
		const tripAdvisorUrl = findTripAdvisorUrl(detail);
		const websiteUrl = findWebsiteUrl(detail) ?? placeCandidate?.website;
		const detailWithLinks = addExternalLinkFields(detail, googleMapsUrl, tripAdvisorUrl);

		results.push({
			id: detailFile.replace(/\.md$/, ''),
			name: link.text,
			country,
			city,
			rating: cells[3] ?? '',
			period: cells[4] ?? '',
			price: cells[5] ?? '',
			withHousing: cells[6] ?? '',
			notes: cells[7] ?? '',
			ratingValue: parseRatingValue(cells[3] ?? ''),
			websiteUrl,
			googleMapsUrl,
			tripAdvisorUrl,
			detailFile,
			detail: detailWithLinks,
		});
	}

	return results;
}

async function readPlaceCandidates(): Promise<PlaceCandidate[]> {
	const candidatesPath = path.join(rootDir, 'data/raw/google-places-candidates.json');
	if (!existsSync(candidatesPath)) {
		return [];
	}

	const raw = JSON.parse(await Bun.file(candidatesPath).text()) as {
		candidates?: PlaceCandidate[];
	};
	return raw.candidates ?? [];
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

function parseDetailMarkdown(markdown: string): DetailData {
	const visibleMarkdown = stripHtmlComments(markdown);
	const lines = visibleMarkdown.split('\n');
	const title =
		lines
			.find(line => line.startsWith('# '))
			?.replace(/^# /, '')
			.trim() ?? 'Details';
	const imageLine = lines.find(line => line.startsWith('!['));
	const imageMatch = imageLine?.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
	const fields: DetailData['fields'] = [];
	const sources: string[] = [];
	let inSources = false;

	for (const line of lines) {
		if (line.trim() === 'Sources:') {
			inSources = true;
			continue;
		}

		if (inSources) {
			const source = line.match(/^- (.+)$/)?.[1]?.trim();
			if (source) {
				sources.push(source);
			}
			continue;
		}

		const field = line.match(/^([^:#][^:]{1,45}):\s+(.+)$/);
		if (field?.[1] && field[2]) {
			fields.push({
				label: field[1].trim(),
				value: field[2].trim(),
			});
		}
	}

	return {
		title,
		image: imageMatch?.[2]
			? {
					alt: imageMatch[1] ?? title,
					url: imageMatch[2],
				}
			: undefined,
		fields,
		sources,
		raw: visibleMarkdown,
	};
}

function stripHtmlComments(markdown: string): string {
	return markdown.replace(/^<!--[\s\S]*?-->\n?/gm, '');
}

function findPlaceCandidate(
	candidates: PlaceCandidate[],
	name: string,
	country: string,
	city: string,
): PlaceCandidate | undefined {
	const normalizedName = compactName(name);
	const normalizedCountry = normalizeText(country);
	const normalizedCity = normalizeText(city);
	const sameCountry = candidates.filter(candidate => normalizeText(candidate.country) === normalizedCountry);

	return (
		sameCountry.find(candidate => compactName(candidate.name) === normalizedName) ??
		sameCountry.find(candidate => {
			const candidateName = compactName(candidate.name);
			return candidateName.includes(normalizedName) || normalizedName.includes(candidateName);
		}) ??
		sameCountry.find(candidate => {
			const candidateName = normalizeText(candidate.name);
			const candidateCity = normalizeText(candidate.city ?? '');
			return candidateCity === normalizedCity && tokenOverlap(candidateName, normalizeText(name)) >= 0.55;
		})
	);
}

function addExternalLinkFields(
	detail: DetailData,
	googleMapsUrl: string,
	tripAdvisorUrl: string | undefined,
): DetailData {
	const labels = new Set(detail.fields.map(field => normalizeText(field.label)));
	const externalFields = [
		...(labels.has('google maps') ? [] : [{ label: 'Google Maps', value: googleMapsUrl }]),
		...(labels.has('tripadvisor') ? [] : [{ label: 'Tripadvisor', value: tripAdvisorUrl ?? '-' }]),
	];
	if (!externalFields.length) {
		return detail;
	}

	const fields: DetailData['fields'] = [];
	let inserted = false;

	for (const field of detail.fields) {
		fields.push(field);
		if (!inserted && normalizeText(field.label) === 'website') {
			fields.push(...externalFields);
			inserted = true;
		}
	}

	if (!inserted) {
		fields.unshift(...externalFields);
	}

	return {
		...detail,
		fields,
	};
}

function findWebsiteUrl(detail: DetailData): string | undefined {
	const website = detail.fields.find(field => normalizeText(field.label) === 'website')?.value;
	return findFirstUrl(website ?? '');
}

function findTripAdvisorUrl(detail: DetailData): string | undefined {
	const values = [detail.raw, ...detail.sources];
	for (const value of values) {
		const url = findFirstUrl(value, url => {
			const normalized = url.toLowerCase();
			return normalized.includes('tripadvisor.') && !normalized.includes('/img/');
		});
		if (url) {
			return url;
		}
	}
	return undefined;
}

function findFirstUrl(value: string, predicate: (url: string) => boolean = () => true): string | undefined {
	for (const match of value.matchAll(/https?:\/\/[^\s)\]>"]+/g)) {
		const url = match[0]?.replace(/[.,;:]+$/, '');
		if (url && predicate(url)) {
			return url;
		}
	}
	return undefined;
}

function googleMapsSearchUrl(name: string, city: string, country: string): string {
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
		[name, city, country].filter(Boolean).join(' '),
	)}`;
}

function parseRatingValue(value: string): number | undefined {
	const match = value.match(/\d+(?:\.\d+)?/);
	if (!match?.[0]) {
		return undefined;
	}
	return Number(match[0]);
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

function tokenOverlap(left: string, right: string): number {
	const leftTokens = new Set(left.split(' ').filter(Boolean));
	const rightTokens = new Set(right.split(' ').filter(Boolean));
	if (!leftTokens.size || !rightTokens.size) {
		return 0;
	}

	let matches = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) {
			matches++;
		}
	}
	return matches / Math.max(leftTokens.size, rightTokens.size);
}

function renderPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<link rel="icon" type="image/svg+xml" href="/favicon.svg">
	<title>Surf Trip Results</title>
	<style>
		:root {
			color-scheme: light;
			--bg: #f7f6f2;
			--panel: #ffffff;
			--text: #1e2527;
			--muted: #657174;
			--line: #d9ded9;
			--accent: #0f766e;
			--accent-soft: #e4f1ef;
			--warn: #a16207;
			--warn-soft: #fff4d6;
			--yes: #0f766e;
			--yes-soft: #dff4ee;
			--no: #b42318;
			--no-soft: #ffe7e3;
			--maybe: #9a6700;
			--maybe-soft: #fff3c4;
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			background: var(--bg);
			color: var(--text);
			font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			font-size: 14px;
			line-height: 1.45;
		}

		button,
		input,
		select {
			font: inherit;
		}

		.shell {
			min-height: 100vh;
			display: grid;
			grid-template-rows: auto 1fr;
		}

		header {
			padding: 16px 20px 14px;
			border-bottom: 1px solid var(--line);
			background: var(--panel);
		}

		h1 {
			margin: 0;
			font-size: 20px;
			font-weight: 700;
			letter-spacing: 0;
		}

		.header-top {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 16px;
		}

		.header-actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.summary {
			margin-top: 6px;
			color: var(--muted);
			font-size: 13px;
		}

		.controls {
			display: grid;
			grid-template-columns: minmax(220px, 1fr) 180px 150px;
			gap: 10px;
			margin-top: 14px;
		}

		.controls input,
		.controls select {
			width: 100%;
			border: 1px solid var(--line);
			background: #fbfbf8;
			color: var(--text);
			border-radius: 6px;
			padding: 9px 10px;
		}

		.controls select[multiple] {
			min-height: 88px;
			padding: 6px 8px;
		}

		.github-button,
		.export-button {
			min-height: 38px;
			border: 1px solid var(--accent);
			border-radius: 6px;
			font-weight: 700;
			white-space: nowrap;
			cursor: pointer;
		}

		.github-button {
			width: 38px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: #ffffff;
			color: var(--accent);
			text-decoration: none;
		}

		.github-button svg {
			width: 20px;
			height: 20px;
			stroke-width: 2;
		}

		.github-button:hover {
			background: var(--accent-soft);
		}

		.export-button {
			background: var(--accent);
			color: #ffffff;
			padding: 8px 10px;
		}

		.github-button:focus-visible,
		.export-button:focus-visible,
		.detail-close:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: 2px;
		}

		main {
			display: grid;
			grid-template-columns: minmax(520px, 1fr) minmax(360px, 42vw);
			align-items: start;
			min-height: 0;
		}

		main.detail-closed {
			grid-template-columns: 1fr;
		}

		main.detail-closed .detail {
			display: none;
		}

		main.detail-closed .results {
			border-right: 0;
		}

		.results {
			min-width: 0;
			border-right: 1px solid var(--line);
			overflow: auto;
		}

		table {
			width: 100%;
			border-collapse: collapse;
			background: var(--panel);
		}

		th {
			position: sticky;
			top: 0;
			z-index: 1;
			background: #f0f1ec;
			color: #334043;
			text-align: left;
			font-size: 12px;
			font-weight: 700;
			border-bottom: 1px solid var(--line);
			padding: 9px 10px;
			white-space: nowrap;
		}

		td {
			vertical-align: top;
			border-bottom: 1px solid var(--line);
			padding: 10px;
		}

		tr {
			cursor: pointer;
		}

		tr:hover,
		tr.selected {
			background: var(--accent-soft);
		}

		.name-button {
			display: block;
			width: 100%;
			border: 0;
			padding: 0;
			background: transparent;
			color: var(--accent);
			text-align: left;
			font-weight: 700;
			cursor: pointer;
		}

		.name-button:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: 2px;
			border-radius: 3px;
		}

		.country,
		.rating,
		.housing,
		.status {
			white-space: nowrap;
		}

		.status {
			width: 54px;
		}

		.sort-button {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			border: 0;
			padding: 0;
			background: transparent;
			color: inherit;
			font-weight: inherit;
			cursor: pointer;
		}

		.sort-button:focus-visible,
		.status-toggle:focus-visible,
		.rating-link:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: 2px;
			border-radius: 3px;
		}

		.sort-direction {
			min-width: 10px;
			color: var(--muted);
		}

		.status-toggle {
			min-width: 46px;
			border: 1px solid var(--line);
			border-radius: 999px;
			padding: 3px 7px;
			background: #f0f1ec;
			color: var(--muted);
			font-size: 12px;
			font-weight: 700;
			cursor: pointer;
		}

		.status-yes {
			border-color: var(--yes);
			background: var(--yes-soft);
			color: var(--yes);
		}

		.status-no {
			border-color: var(--no);
			background: var(--no-soft);
			color: var(--no);
		}

		.status-meh {
			border-color: var(--maybe);
			background: var(--maybe-soft);
			color: var(--maybe);
		}

		.rating-link {
			color: var(--accent);
			font-weight: 700;
			text-decoration-thickness: 1px;
			text-underline-offset: 2px;
		}

		.price,
		.period {
			min-width: 190px;
		}

		.notes {
			min-width: 260px;
			color: #3e4a4d;
		}

		.detail {
			position: sticky;
			top: 0;
			min-width: 0;
			max-height: 100vh;
			overflow: auto;
			background: #fbfbf8;
		}

		.detail-inner {
			padding: 18px 20px 28px;
			max-width: 900px;
		}

		.detail-title-row {
			display: grid;
			grid-template-columns: 1fr auto;
			align-items: start;
			gap: 12px;
		}

		.detail h2 {
			margin: 0 0 12px;
			font-size: 22px;
			line-height: 1.2;
			letter-spacing: 0;
		}

		.detail-close {
			width: 26px;
			height: 26px;
			border: 1px solid var(--line);
			border-radius: 999px;
			background: var(--panel);
			color: var(--muted);
			font-size: 16px;
			line-height: 1;
			cursor: pointer;
		}

		.detail-close:hover {
			color: var(--text);
			border-color: var(--muted);
		}

		.hero-image {
			width: 100%;
			max-height: 270px;
			object-fit: cover;
			border-radius: 6px;
			border: 1px solid var(--line);
			background: #e7e3da;
			margin-bottom: 14px;
		}

		.field-grid {
			display: grid;
			gap: 1px;
			border: 1px solid var(--line);
			border-radius: 6px;
			overflow: hidden;
			background: var(--line);
		}

		.field {
			display: grid;
			grid-template-columns: 140px 1fr;
			background: var(--panel);
		}

		.field-label {
			padding: 10px;
			color: var(--muted);
			background: #f0f1ec;
			font-size: 12px;
			font-weight: 700;
			text-transform: uppercase;
		}

		.field-value {
			padding: 10px;
			min-width: 0;
			overflow-wrap: anywhere;
		}

		.warning {
			margin: 0 0 14px;
			padding: 10px 12px;
			border: 1px solid #edd28a;
			border-radius: 6px;
			background: var(--warn-soft);
			color: var(--warn);
		}

		.sources {
			margin-top: 18px;
		}

		.sources h3 {
			margin: 0 0 8px;
			font-size: 14px;
		}

		.sources a {
			color: var(--accent);
			overflow-wrap: anywhere;
		}

		.empty {
			padding: 28px;
			color: var(--muted);
		}

		@media (max-width: 980px) {
			.header-top {
				flex-wrap: wrap;
			}

			.controls {
				grid-template-columns: 1fr;
			}

			main {
				grid-template-columns: 1fr;
			}

			.results {
				border-right: 0;
				max-height: 52vh;
			}

			.detail {
				position: static;
				max-height: none;
				border-top: 1px solid var(--line);
			}
		}
	</style>
</head>
<body>
	<div class="shell">
		<header>
			<div class="header-top">
				<div>
					<h1>Surf Trip Results</h1>
					<div id="summary" class="summary">Loading results...</div>
				</div>
				<div class="header-actions">
					<a class="github-button" href="https://github.com/smirea/travel-surfing-planner" target="_blank" rel="noreferrer" aria-label="Open GitHub repository" title="Open GitHub repository">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5a10.5 10.5 0 0 0-6 0C8 2 7 2 7 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 6 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
							<path d="M9 18c-4.51 2-5-2-7-2"/>
						</svg>
					</a>
					<button id="exportCsv" class="export-button" type="button">Export CSV</button>
				</div>
			</div>
			<div class="controls">
				<input id="search" type="search" placeholder="Search schools, cities, notes, prices">
				<select id="country" multiple size="5" aria-label="Countries"></select>
				<select id="housing">
					<option value="">All housing</option>
					<option value="yes">Housing likely</option>
					<option value="unclear">Housing unclear</option>
				</select>
			</div>
		</header>
		<main id="layout">
			<section class="results" aria-label="Results">
				<table>
					<thead>
						<tr>
							<th>Status</th>
							<th><button class="sort-button" type="button" data-sort="name">Name <span class="sort-direction" data-sort-direction="name"></span></button></th>
							<th><button class="sort-button" type="button" data-sort="country">Country <span class="sort-direction" data-sort-direction="country"></span></button></th>
							<th>City</th>
							<th><button class="sort-button" type="button" data-sort="rating">Rating <span class="sort-direction" data-sort-direction="rating"></span></button></th>
							<th>Housing</th>
							<th>Price</th>
							<th>Period</th>
							<th>Notes</th>
						</tr>
					</thead>
					<tbody id="rows"></tbody>
				</table>
			</section>
			<aside class="detail" aria-label="School details">
				<div id="detail" class="detail-inner empty">Select a school to see the details.</div>
			</aside>
		</main>
	</div>
	<script>
		let allResults = [];
		let visibleResults = [];
		let selectedId = "";
		let detailOpen = true;
		const statusStorageKey = "travel-surfing-planner:school-status:v1";
		const statusValues = ["yes", "no", "meh", "-"];
		let sortState = { key: "", direction: "asc" };
		let statuses = loadStatuses();

		const layout = document.querySelector("#layout");
		const rows = document.querySelector("#rows");
		const detail = document.querySelector("#detail");
		const summary = document.querySelector("#summary");
		const search = document.querySelector("#search");
		const country = document.querySelector("#country");
		const housing = document.querySelector("#housing");
		const exportCsvButton = document.querySelector("#exportCsv");
		const sortButtons = document.querySelectorAll("[data-sort]");
		const sortDirectionLabels = document.querySelectorAll("[data-sort-direction]");

		function loadStatuses() {
			try {
				const saved = localStorage.getItem(statusStorageKey);
				return saved ? JSON.parse(saved) : {};
			} catch {
				return {};
			}
		}

		function saveStatuses() {
			localStorage.setItem(statusStorageKey, JSON.stringify(statuses));
		}

		function currentStatus(id) {
			if (statuses[id] === "maybe") return "meh";
			return statusValues.includes(statuses[id]) ? statuses[id] : "-";
		}

		function toggleStatus(id) {
			const currentIndex = statusValues.indexOf(currentStatus(id));
			const next = statusValues[(currentIndex + 1) % statusValues.length];
			if (next === "-") {
				delete statuses[id];
			} else {
				statuses[id] = next;
			}
			saveStatuses();
			renderRows();
		}

		function escapeHtml(value) {
			return String(value ?? "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		}

		function textIncludes(result, query) {
			if (!query) return true;
			const haystack = [
				result.name,
				result.country,
				result.city,
				result.rating,
				result.period,
				result.price,
				result.withHousing,
				result.notes,
				result.detail.raw,
			].join(" ").toLowerCase();
			return haystack.includes(query);
		}

		function housingMatches(result, value) {
			if (!value) return true;
			const normalized = result.withHousing.toLowerCase();
			if (value === "yes") return normalized.includes("yes") || normalized.includes("likely") || normalized.includes("custom");
			if (value === "unclear") return normalized.includes("unclear") || normalized.includes("separate") || normalized.includes("no package");
			return true;
		}

		function selectedCountries() {
			return [...country.selectedOptions].map(option => option.value);
		}

		function applyFilters() {
			const query = search.value.trim().toLowerCase();
			const countries = selectedCountries();
			visibleResults = sortResults(allResults.filter(result =>
				textIncludes(result, query) &&
				(!countries.length || countries.includes(result.country)) &&
				housingMatches(result, housing.value)
			));

			if (detailOpen && !visibleResults.some(result => result.id === selectedId)) {
				selectedId = visibleResults[0]?.id ?? "";
			} else if (!detailOpen && !visibleResults.some(result => result.id === selectedId)) {
				selectedId = "";
			}

			renderRows();
			renderDetail();
			renderSortIndicators();
		}

		function sortResults(results) {
			if (!sortState.key) return results;
			const sorted = [...results];
			const direction = sortState.direction === "desc" ? -1 : 1;

			sorted.sort((left, right) => {
				if (sortState.key === "rating") {
					const leftRating = Number.isFinite(left.ratingValue) ? left.ratingValue : -1;
					const rightRating = Number.isFinite(right.ratingValue) ? right.ratingValue : -1;
					return (leftRating - rightRating) * direction;
				}

				const leftValue = String(left[sortState.key] ?? "").toLowerCase();
				const rightValue = String(right[sortState.key] ?? "").toLowerCase();
				return leftValue.localeCompare(rightValue) * direction;
			});

			return sorted;
		}

		function renderSortIndicators() {
			for (const label of sortDirectionLabels) {
				label.textContent = label.dataset.sortDirection === sortState.key
					? (sortState.direction === "asc" ? "▲" : "▼")
					: "";
			}
		}

		function renderRows() {
			summary.textContent = \`\${visibleResults.length} of \${allResults.length} schools shown\`;
			rows.innerHTML = visibleResults.map(result => {
				const status = currentStatus(result.id);
				const statusClass = status === "-" ? "empty" : status;
				const rating = result.googleMapsUrl
					? \`<a class="rating-link" href="\${escapeHtml(result.googleMapsUrl)}" target="_blank" rel="noreferrer">\${escapeHtml(result.rating)}</a>\`
					: escapeHtml(result.rating);
				return \`
					<tr class="\${result.id === selectedId ? "selected" : ""}" data-id="\${escapeHtml(result.id)}">
						<td class="status"><button class="status-toggle status-\${statusClass}" type="button" data-status-id="\${escapeHtml(result.id)}">\${escapeHtml(status)}</button></td>
						<td><button class="name-button" type="button" data-id="\${escapeHtml(result.id)}">\${escapeHtml(result.name)}</button></td>
						<td class="country">\${escapeHtml(result.country)}</td>
						<td>\${escapeHtml(result.city)}</td>
						<td class="rating">\${rating}</td>
						<td class="housing">\${escapeHtml(result.withHousing)}</td>
						<td class="price">\${escapeHtml(result.price)}</td>
						<td class="period">\${escapeHtml(result.period)}</td>
						<td class="notes">\${escapeHtml(result.notes)}</td>
					</tr>
				\`;
			}).join("");
		}

		function renderDetail() {
			layout.classList.toggle("detail-closed", !detailOpen);
			if (!detailOpen) return;

			const result = allResults.find(item => item.id === selectedId);
			if (!result) {
				detail.className = "detail-inner empty";
				detail.textContent = "No matching schools.";
				return;
			}

			const warning = result.notes.toLowerCase().includes("confirm")
				? '<p class="warning">This row still needs direct operator confirmation for exact dates, language, or pricing.</p>'
				: "";
			const image = result.detail.image
				? \`<img class="hero-image" src="\${escapeHtml(result.detail.image.url)}" alt="\${escapeHtml(result.detail.image.alt)}" loading="lazy">\`
				: "";
			const fields = result.detail.fields.map(field => \`
				<div class="field">
					<div class="field-label">\${escapeHtml(field.label)}</div>
					<div class="field-value">\${linkify(escapeHtml(field.value))}</div>
				</div>
			\`).join("");
			const sources = result.detail.sources.length
				? \`<div class="sources"><h3>Sources</h3><ul>\${result.detail.sources.map(source => \`<li><a href="\${escapeHtml(source)}" target="_blank" rel="noreferrer">\${escapeHtml(source)}</a></li>\`).join("")}</ul></div>\`
				: "";

			detail.className = "detail-inner";
			detail.innerHTML = \`
				<div class="detail-title-row">
					<h2>\${escapeHtml(result.detail.title || result.name)}</h2>
					<button class="detail-close" type="button" data-close-detail aria-label="Close detail panel"><span aria-hidden="true">&times;</span></button>
				</div>
				\${warning}
				\${image}
				<div class="field-grid">
					<div class="field">
						<div class="field-label">Result notes</div>
						<div class="field-value">\${escapeHtml(result.notes)}</div>
					</div>
					\${fields}
				</div>
				\${sources}
			\`;
		}

		function linkify(value) {
			return value.replace(/(https?:\\/\\/[^\\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
		}

		function selectResult(id) {
			selectedId = id;
			detailOpen = true;
			history.replaceState(null, "", "#" + encodeURIComponent(id));
			renderRows();
			renderDetail();
		}

		function closeDetail() {
			selectedId = "";
			detailOpen = false;
			history.replaceState(null, "", location.pathname + location.search);
			renderRows();
			renderDetail();
		}

		function exportCsv() {
			const columns = [
				["status", result => currentStatus(result.id)],
				["name", result => result.name],
				["country", result => result.country],
				["city", result => result.city],
				["rating", result => result.rating],
				["period", result => result.period],
				["price", result => result.price],
				["housing", result => result.withHousing],
				["notes", result => result.notes],
				["website", result => result.websiteUrl],
				["google_maps", result => result.googleMapsUrl],
				["tripadvisor", result => result.tripAdvisorUrl],
				["detail_file", result => result.detailFile],
			];
			const csv = [
				columns.map(([label]) => csvCell(label)).join(","),
				...visibleResults.map(result => columns.map(([, read]) => csvCell(read(result))).join(",")),
			].join("\\n");
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = \`surf-trip-results-\${new Date().toISOString().slice(0, 10)}.csv\`;
			link.click();
			URL.revokeObjectURL(url);
		}

		function csvCell(value) {
			const text = String(value ?? "");
			return /[",\\n\\r]/.test(text) ? \`"\${text.replace(/"/g, '""')}"\` : text;
		}

		detail.addEventListener("click", event => {
			if (event.target.closest("[data-close-detail]")) closeDetail();
		});
		rows.addEventListener("click", event => {
			const statusButton = event.target.closest("[data-status-id]");
			if (statusButton) {
				toggleStatus(statusButton.dataset.statusId);
				return;
			}
			if (event.target.closest("a")) return;
			const target = event.target.closest("[data-id]");
			if (target) selectResult(target.dataset.id);
		});
		for (const button of sortButtons) {
			button.addEventListener("click", () => {
				const key = button.dataset.sort;
				const defaultDirection = key === "rating" ? "desc" : "asc";
				const nextDirection =
					sortState.key === key
						? (sortState.direction === "asc" ? "desc" : "asc")
						: defaultDirection;
				sortState = { key, direction: nextDirection };
				applyFilters();
			});
		}
		search.addEventListener("input", applyFilters);
		country.addEventListener("change", applyFilters);
		housing.addEventListener("change", applyFilters);
		exportCsvButton.addEventListener("click", exportCsv);

		fetch("/api/results")
			.then(response => response.json())
			.then(results => {
				allResults = results;
				for (const value of [...new Set(results.map(result => result.country))].sort()) {
					const option = document.createElement("option");
					option.value = value;
					option.textContent = value;
					country.append(option);
				}
				selectedId = decodeURIComponent(location.hash.slice(1)) || results[0]?.id || "";
				applyFilters();
			})
			.catch(error => {
				summary.textContent = "Could not load results.";
				detail.textContent = error instanceof Error ? error.message : String(error);
			});
	</script>
</body>
</html>`;
}
