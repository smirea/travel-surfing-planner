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
	detailFile: string;
	detail: DetailData;
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

async function readResults(): Promise<ResultRow[]> {
	const resultPath = path.join(rootDir, 'data/result.md');
	const resultMarkdown = await Bun.file(resultPath).text();
	const tableLines = resultMarkdown.split('\n').filter(line => line.startsWith('| ['));

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

		results.push({
			id: detailFile.replace(/\.md$/, ''),
			name: link.text,
			country: cells[1] ?? '',
			city: cells[2] ?? '',
			rating: cells[3] ?? '',
			period: cells[4] ?? '',
			price: cells[5] ?? '',
			withHousing: cells[6] ?? '',
			notes: cells[7] ?? '',
			detailFile,
			detail,
		});
	}

	return results;
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
	const lines = markdown.split('\n');
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
		raw: markdown,
	};
}

function renderPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
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

		main {
			display: grid;
			grid-template-columns: minmax(520px, 1fr) minmax(360px, 42vw);
			min-height: 0;
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
		.housing {
			white-space: nowrap;
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
			min-width: 0;
			overflow: auto;
			background: #fbfbf8;
		}

		.detail-inner {
			padding: 18px 20px 28px;
			max-width: 900px;
		}

		.detail h2 {
			margin: 0 0 12px;
			font-size: 22px;
			line-height: 1.2;
			letter-spacing: 0;
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
				border-top: 1px solid var(--line);
			}
		}
	</style>
</head>
<body>
	<div class="shell">
		<header>
			<h1>Surf Trip Results</h1>
			<div id="summary" class="summary">Loading results...</div>
			<div class="controls">
				<input id="search" type="search" placeholder="Search schools, cities, notes, prices">
				<select id="country">
					<option value="">All countries</option>
				</select>
				<select id="housing">
					<option value="">All housing</option>
					<option value="yes">Housing likely</option>
					<option value="unclear">Housing unclear</option>
				</select>
			</div>
		</header>
		<main>
			<section class="results" aria-label="Results">
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Country</th>
							<th>City</th>
							<th>Rating</th>
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

		const rows = document.querySelector("#rows");
		const detail = document.querySelector("#detail");
		const summary = document.querySelector("#summary");
		const search = document.querySelector("#search");
		const country = document.querySelector("#country");
		const housing = document.querySelector("#housing");

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

		function applyFilters() {
			const query = search.value.trim().toLowerCase();
			visibleResults = allResults.filter(result =>
				textIncludes(result, query) &&
				(!country.value || result.country === country.value) &&
				housingMatches(result, housing.value)
			);

			if (!visibleResults.some(result => result.id === selectedId)) {
				selectedId = visibleResults[0]?.id ?? "";
			}

			renderRows();
			renderDetail();
		}

		function renderRows() {
			summary.textContent = \`\${visibleResults.length} of \${allResults.length} schools shown\`;
			rows.innerHTML = visibleResults.map(result => \`
				<tr class="\${result.id === selectedId ? "selected" : ""}" data-id="\${escapeHtml(result.id)}">
					<td><button class="name-button" type="button" data-id="\${escapeHtml(result.id)}">\${escapeHtml(result.name)}</button></td>
					<td class="country">\${escapeHtml(result.country)}</td>
					<td>\${escapeHtml(result.city)}</td>
					<td class="rating">\${escapeHtml(result.rating)}</td>
					<td class="housing">\${escapeHtml(result.withHousing)}</td>
					<td class="price">\${escapeHtml(result.price)}</td>
					<td class="period">\${escapeHtml(result.period)}</td>
					<td class="notes">\${escapeHtml(result.notes)}</td>
				</tr>
			\`).join("");
		}

		function renderDetail() {
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
				<h2>\${escapeHtml(result.detail.title || result.name)}</h2>
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
			history.replaceState(null, "", "#" + encodeURIComponent(id));
			renderRows();
			renderDetail();
		}

		rows.addEventListener("click", event => {
			const target = event.target.closest("[data-id]");
			if (target) selectResult(target.dataset.id);
		});
		search.addEventListener("input", applyFilters);
		country.addEventListener("change", applyFilters);
		housing.addEventListener("change", applyFilters);

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
