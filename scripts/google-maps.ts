#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { writeEnvLocalValues } from './env-local';

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const DEFAULT_RADIUS_METERS = 10_000;
const DEFAULT_FIELD_MASK = [
	'places.name',
	'places.id',
	'places.displayName',
	'places.formattedAddress',
	'places.location',
	'places.rating',
	'places.userRatingCount',
	'places.priceLevel',
	'places.primaryType',
	'places.types',
	'places.businessStatus',
	'places.googleMapsUri',
	'places.websiteUri',
	'places.nationalPhoneNumber',
].join(',');
const DETAIL_FIELD_MASK = [
	'id',
	'displayName',
	'formattedAddress',
	'location',
	'rating',
	'userRatingCount',
	'priceLevel',
	'primaryType',
	'types',
	'businessStatus',
	'googleMapsUri',
	'websiteUri',
	'nationalPhoneNumber',
	'internationalPhoneNumber',
	'regularOpeningHours',
].join(',');
const REVIEW_DETAIL_FIELD_MASK = `${DETAIL_FIELD_MASK},reviews`;
const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '.env.local');
const ENV_TS_PATH = path.resolve(import.meta.dir, '..', 'src', 'env.ts');

interface SearchOptions {
	limit?: number;
	near?: string;
	radius?: number;
	minRating?: number;
	rank?: string;
	openNow?: boolean;
}

interface NearbyOptions {
	limit?: number;
	radius?: number;
	rank?: string;
}

interface DetailsOptions {
	reviews?: boolean;
}

interface SetupOptions {
	project?: string;
	displayName?: string;
}

interface Place {
	name?: string;
	id?: string;
	displayName?: { text?: string; languageCode?: string };
	formattedAddress?: string;
	location?: { latitude?: number; longitude?: number };
	rating?: number;
	userRatingCount?: number;
	priceLevel?: string;
	primaryType?: string;
	types?: string[];
	businessStatus?: string;
	googleMapsUri?: string;
	websiteUri?: string;
	nationalPhoneNumber?: string;
	internationalPhoneNumber?: string;
	regularOpeningHours?: unknown;
	reviews?: unknown[];
}

interface SearchResponse {
	places?: Place[];
}

const patterns: Record<string, (near: string) => string> = {
	chargers: near => `Tesla Supercharger near ${near}`,
	'surf-lessons': near => `beginner surf lessons surf school near ${near}`,
	'surf-camps': near => `surf camp accommodation beginner lessons near ${near}`,
	stays: near => `hotels guesthouses apartments near ${near}`,
	food: near => `best restaurants cafes near ${near}`,
	'things-to-do': near => `things to do attractions activities near ${near}`,
};

if (import.meta.main) {
	run().catch(error => {
		console.error(
			JSON.stringify(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				null,
				2,
			),
		);
		process.exit(1);
	});
}

async function run(): Promise<void> {
	let cli = yargs(hideBin(process.argv))
		.scriptName('google-maps')
		.usage('$0 <command> [options]')
		.parserConfiguration({
			'strip-aliased': true,
			'strip-dashed': true,
		})
		.command(
			'setup-key',
			'Create or reuse a restricted Google Places API key and save it with env-manager.',
			command =>
				command
					.option('project', {
						type: 'string',
						describe: 'Google Cloud project id. Defaults to the active gcloud project.',
					})
					.option('display-name', {
						type: 'string',
						default: 'travel-surfing-trip Places API',
						describe: 'Display name for the Google Cloud API key.',
					}),
			argv => {
				renderJson(setupGoogleMapsKey(argv));
			},
		)
		.command(
			'patterns',
			'List built-in query shortcuts.',
			() => {},
			() => {
				renderJson(Object.keys(patterns));
			},
		)
		.command(
			['text <query...>', 'search <query...>'],
			'Run a Google Places text search.',
			command =>
				addSearchOptions(
					command.positional('query', {
						type: 'string',
						array: true,
						demandOption: true,
						describe: 'Free-form search query.',
					}),
				),
			async argv => {
				const places = await textSearch(joinPositionals(argv.query), argv);
				renderJson(places);
			},
		)
		.command(
			'nearby <type>',
			'Search for a place type near coordinates.',
			command =>
				addCommonOptions(
					command
						.positional('type', {
							type: 'string',
							demandOption: true,
							describe: 'Google place type, for example restaurant or lodging.',
						})
						.option('lat', {
							type: 'number',
							demandOption: true,
							describe: 'Latitude.',
						})
						.option('lng', {
							type: 'number',
							demandOption: true,
							describe: 'Longitude.',
						})
						.option('radius', {
							type: 'number',
							default: DEFAULT_RADIUS_METERS,
							describe: 'Search radius in meters.',
						})
						.option('rank', {
							type: 'string',
							choices: ['POPULARITY', 'DISTANCE', 'popularity', 'distance'] as const,
							default: 'POPULARITY',
							describe: 'Nearby ranking preference.',
						}),
				),
			async argv => {
				const places = await nearbySearch(String(argv.type), Number(argv.lat), Number(argv.lng), argv);
				renderJson(places);
			},
		)
		.command(
			'details <place...>',
			'Fetch one place by id/resource name or exact text query.',
			command =>
				command
					.positional('place', {
						type: 'string',
						array: true,
						demandOption: true,
						describe: 'Place id, places/... resource name, or exact text query.',
					})
					.option('reviews', {
						type: 'boolean',
						default: false,
						describe: 'Include Google review summaries when available.',
					}),
			async argv => {
				const details = await placeDetails(joinPositionals(argv.place), argv);
				renderJson(details);
			},
		);

	for (const commandName of Object.keys(patterns)) {
		cli = cli.command(
			`${commandName} <near...>`,
			`Run the ${commandName} query shortcut.`,
			command =>
				addSearchOptions(
					command.positional('near', {
						type: 'string',
						array: true,
						demandOption: true,
						describe: 'Location to search near, for example a city, beach, address, or ZIP.',
					}),
					false,
				),
			async argv => {
				const near = joinPositionals(argv.near);
				const places = await textSearch(patterns[commandName](near), { ...argv, near });
				renderJson(places);
			},
		);
	}

	await cli
		.strict()
		.demandCommand(1, 'Choose a command.')
		.recommendCommands()
		.showHelpOnFail(false)
		.fail((message, error) => {
			throw error ?? new Error(message);
		})
		.help()
		.parseAsync();
}

function addSearchOptions<T>(argv: Argv<T>, includeNearOption = true): Argv<T & SearchOptions> {
	let command = addCommonOptions(argv);
	if (includeNearOption) {
		command = command.option('near', {
			type: 'string',
			describe: 'Bias text search around this location.',
		});
	}
	return command
		.option('radius', {
			type: 'number',
			default: DEFAULT_RADIUS_METERS,
			describe: 'Location bias radius in meters.',
		})
		.option('min-rating', {
			type: 'number',
			describe: 'Minimum Google rating.',
		})
		.option('rank', {
			type: 'string',
			choices: ['RELEVANCE', 'DISTANCE', 'relevance', 'distance'] as const,
			describe: 'Text search ranking preference.',
		})
		.option('open-now', {
			type: 'boolean',
			default: false,
			describe: 'Only include places Google reports as open now.',
		});
}

function addCommonOptions<T>(argv: Argv<T>): Argv<T & { limit?: number } & DetailsOptions> {
	return argv.option('limit', {
		type: 'number',
		default: DEFAULT_LIMIT,
		describe: `Maximum results, capped at ${MAX_LIMIT}.`,
	});
}

function joinPositionals(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map(String).join(' ').trim();
	}
	return typeof value === 'string' ? value.trim() : '';
}

async function textSearch(query: string, options: SearchOptions): Promise<Place[]> {
	if (!query) {
		throw new Error('Missing search query.');
	}
	const limit = getLimit(options);
	const body: Record<string, unknown> = {
		textQuery: query,
		pageSize: limit,
	};

	if (options.openNow) {
		body.openNow = true;
	}
	if (options.minRating !== undefined) {
		body.minRating = options.minRating;
	}
	if (options.rank) {
		body.rankPreference = options.rank.toUpperCase();
	}

	if (options.near) {
		const location = await resolveLocation(options.near);
		body.locationBias = {
			circle: {
				center: location,
				radius: getRadius(options),
			},
		};
	}

	const response = await placesFetch<SearchResponse>('places:searchText', body, DEFAULT_FIELD_MASK);
	return response.places ?? [];
}

async function nearbySearch(type: string, lat: number, lng: number, options: NearbyOptions): Promise<Place[]> {
	const body = {
		includedTypes: [type],
		maxResultCount: getLimit(options),
		locationRestriction: {
			circle: {
				center: {
					latitude: lat,
					longitude: lng,
				},
				radius: getRadius(options),
			},
		},
		rankPreference: String(options.rank ?? 'POPULARITY').toUpperCase(),
	};
	const response = await placesFetch<SearchResponse>('places:searchNearby', body, DEFAULT_FIELD_MASK);
	return response.places ?? [];
}

async function placeDetails(place: string, options: DetailsOptions): Promise<Place> {
	if (!place) {
		throw new Error('details requires a place id, places/... resource name, or exact text query.');
	}
	const resourceName = await resolvePlaceResourceName(place);
	const fieldMask = options.reviews ? REVIEW_DETAIL_FIELD_MASK : DETAIL_FIELD_MASK;
	return placesFetch<Place>(resourceName, undefined, fieldMask);
}

async function resolveLocation(input: string): Promise<{ latitude: number; longitude: number }> {
	const response = await placesFetch<SearchResponse>(
		'places:searchText',
		{ textQuery: input, pageSize: 1 },
		'places.location',
	);
	const location = response.places?.[0]?.location;
	if (location?.latitude === undefined || location.longitude === undefined) {
		throw new Error(`Could not resolve location: ${input}`);
	}
	return { latitude: location.latitude, longitude: location.longitude };
}

async function resolvePlaceResourceName(input: string): Promise<string> {
	if (input.startsWith('places/')) {
		return input;
	}
	if (/^[A-Za-z0-9_-]+$/.test(input)) {
		return `places/${input}`;
	}
	const response = await placesFetch<SearchResponse>(
		'places:searchText',
		{ textQuery: input, pageSize: 1 },
		'places.name',
	);
	const name = response.places?.[0]?.name;
	if (!name) {
		throw new Error(`Could not resolve place: ${input}`);
	}
	return name;
}

async function placesFetch<T>(endpoint: string, body: unknown, fieldMask: string): Promise<T> {
	const apiKey = await readGoogleMapsApiKey();
	const response = await fetch(`${PLACES_BASE_URL}/${endpoint}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': apiKey,
			'X-Goog-FieldMask': fieldMask,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Google Places API ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}

async function readGoogleMapsApiKey(): Promise<string> {
	const envModule = (await import('../src/env')) as { default: { GOOGLE_MAPS_API_KEY: string } };
	return envModule.default.GOOGLE_MAPS_API_KEY;
}

function renderJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

interface SetupResult {
	envLocalPath: string;
	envTsPath: string;
	keyName: string;
	displayName: string;
	project?: string;
	synced: boolean;
}

function setupGoogleMapsKey(options: SetupOptions): SetupResult {
	const project = options.project;
	const displayName = options.displayName ?? 'travel-surfing-trip Places API';
	const projectArgs = project ? ['--project', project] : [];

	runCommand('gcloud', ['services', 'enable', 'apikeys.googleapis.com', 'places.googleapis.com', ...projectArgs]);

	const existingKeys = runJson<GoogleApiKey[]>('gcloud', [
		'services',
		'api-keys',
		'list',
		'--format=json',
		`--filter=displayName="${displayName}"`,
		...projectArgs,
	]);

	const keyName =
		existingKeys.find(key => key.displayName === displayName)?.name ?? createGoogleMapsKey(displayName, projectArgs);
	const keyString = getKeyString(keyName, projectArgs);

	writeEnvLocalValues(ENV_LOCAL_PATH, { GOOGLE_MAPS_API_KEY: keyString });
	runCommand('env-manager', ['ts', 'src/env.ts', '--force']);
	runCommand('env-manager', ['up']);
	return {
		envLocalPath: path.relative(process.cwd(), ENV_LOCAL_PATH),
		envTsPath: path.relative(process.cwd(), ENV_TS_PATH),
		keyName,
		displayName,
		project,
		synced: true,
	};
}

interface GoogleApiKey {
	name?: string;
	displayName?: string;
}

function createGoogleMapsKey(displayName: string, projectArgs: string[]): string {
	const created = runJson<unknown>('gcloud', [
		'services',
		'api-keys',
		'create',
		'--display-name',
		displayName,
		'--api-target',
		'service=places.googleapis.com',
		'--format=json',
		...projectArgs,
	]);
	const keyName = findKeyName(created);
	if (!keyName) {
		throw new Error('gcloud did not return a key resource name after creating the API key.');
	}
	return keyName;
}

function getKeyString(keyName: string, projectArgs: string[]): string {
	const result = runJson<{ keyString?: string }>('gcloud', [
		'services',
		'api-keys',
		'get-key-string',
		keyName,
		'--format=json',
		...projectArgs,
	]);
	if (!result.keyString) {
		throw new Error('gcloud did not return keyString.');
	}
	return result.keyString;
}

function findKeyName(value: unknown): string | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name === 'string' && record.name.includes('/keys/')) {
		return record.name;
	}
	for (const child of Object.values(record)) {
		const found = findKeyName(child);
		if (found) {
			return found;
		}
	}
	return null;
}

function runJson<T>(command: string, args: string[]): T {
	const output = runCommand(command, args);
	return JSON.parse(output) as T;
}

function runCommand(command: string, args: string[]): string {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

function getLimit(options: { limit?: number }): number {
	const requested = options.limit ?? DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)));
}

function getRadius(options: { radius?: number }): number {
	const requested = options.radius ?? DEFAULT_RADIUS_METERS;
	return Math.max(1, requested);
}
