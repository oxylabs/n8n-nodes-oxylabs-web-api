import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { jsonParse, NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	operationProperties,
	requestProperties,
	resourceProperty,
	scrapeProperties,
	scraperProperties,
	searchProperties,
} from './descriptions';
import type { ParseFault, WaitOptions } from './transport';
import {
	apiRequest,
	check,
	collect,
	isParseFault,
	pending,
	requestIdOf,
	runScrape,
} from './transport';

type Groups = Record<string, string>;

const JSON_NOT_SUPPORTED = 'json_not_supported';
const AI_ONLY = 'json_supported_only_with_prompt_or_schema';
const ENDPOINT_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

function asNodeError(node: INode, error: unknown, itemIndex: number) {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(node, error as Error, { itemIndex });
}

/** Accept a scraper path such as `scrape/amazon/search`, never a URL: every segment is checked. */
function endpointName(node: INode, value: string, itemIndex: number): string {
	let name = value.trim().replace(/^\/+|\/+$/g, '');
	if (name.startsWith('v1/')) name = name.slice(3);
	if (!name || !name.split('/').every((segment) => ENDPOINT_SEGMENT.test(segment))) {
		throw new NodeOperationError(node, `"${value}" is not a scraper name`, {
			description: 'Use a path from the Scraper list, without /v1/, e.g. scrape/amazon/search.',
			itemIndex,
		});
	}
	return name;
}

function parseObject(node: INode, value: unknown, field: string, itemIndex: number): IDataObject {
	const parsed =
		typeof value === 'string'
			? jsonParse<unknown>(value, { errorMessage: `${field} is not valid JSON` })
			: value;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new NodeOperationError(node, `${field} must be a JSON object`, { itemIndex });
	}
	return parsed as IDataObject;
}

/** True when no result carries any parsed JSON. */
function jsonEmpty(response: IDataObject): boolean {
	const results = Array.isArray(response.results) ? (response.results as IDataObject[]) : [];
	return results.every((result) => {
		const value = result.json;
		if (value === null || value === undefined || value === '') return true;
		if (Array.isArray(value)) return value.length === 0;
		return typeof value === 'object' && Object.keys(value).length === 0;
	});
}

/** `output` for a request for JSON: the caller's own list when it already asks for JSON. */
function jsonOutput(output: unknown): string[] {
	if (Array.isArray(output) && output.includes('json')) return [...new Set(output.map(String))];
	return ['json'];
}

export class OxylabsWebApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Oxylabs Web API',
		name: 'oxylabsWebApi',
		icon: { light: 'file:../../icons/oxylabs.svg', dark: 'file:../../icons/oxylabs.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Search the web and scrape any page with the Oxylabs Web API',
		defaults: {
			name: 'Oxylabs Web API',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'oxylabsWebApi',
				required: true,
			},
		],
		properties: [
			resourceProperty,
			...operationProperties,
			...searchProperties,
			...scrapeProperties,
			...scraperProperties,
			...requestProperties,
		],
	};

	methods = {
		loadOptions: {
			async getScrapers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const body = check.call(
					this,
					await apiRequest.call(this, 'GET', '/v1/scrapers'),
					'/v1/scrapers',
				);
				const paths = (Array.isArray(body.scrapers) ? body.scrapers : []).map(String);
				const listed = new Set(paths);
				const options: INodePropertyOptions[] = [];
				for (const path of paths) {
					const name = path.replace(/^\/v1\//, '');
					// The generic scraper is the Scrape resource; batches are what n8n items already are.
					if (name === 'scrape' || name === 'async/scrape' || name.includes('batch')) continue;
					if (name.startsWith('async/')) {
						// Shown once, in its synchronous form, when that exists.
						if (listed.has(`/v1/${name.slice('async/'.length)}`)) continue;
						options.push({
							name: `${name.slice('async/scrape/'.length)} (queued only)`,
							value: name,
						});
					} else {
						options.push({ name: name.slice('scrape/'.length), value: name });
					}
				}
				return options.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const node = this.getNode();
		let groups: Groups | undefined | null = null;

		/** Every scraper path mapped to its JSON group, read once per execution; undefined if unknown. */
		const scraperGroups = async (): Promise<Groups | undefined> => {
			if (groups !== null) return groups;
			const path = '/v1/scrapers?group_by=json_output_support';
			const response = await apiRequest.call(this, 'GET', path);
			// A failed lookup is not fatal: the scrape itself answers with the authoritative error.
			const listed = response.status === 200 ? response.body?.scrapers : undefined;
			if (typeof listed !== 'object' || listed === null) {
				groups = undefined;
				return groups;
			}
			groups = {};
			for (const [group, paths] of Object.entries(listed as IDataObject)) {
				if (Array.isArray(paths)) for (const path of paths) groups[String(path)] = group;
			}
			return groups;
		};

		const fieldsSpec = (itemIndex: number): IDataObject => {
			if (this.getNodeParameter('describeWith', itemIndex) === 'schema') {
				const schema = this.getNodeParameter('jsonSchema', itemIndex);
				return { schema: parseObject(node, schema, 'JSON Schema', itemIndex) };
			}
			const prompt = (this.getNodeParameter('jsonPrompt', itemIndex) as string).trim();
			if (!prompt) {
				throw new NodeOperationError(node, 'Prompt must name the fields to pull out', {
					itemIndex,
				});
			}
			return { prompt };
		};

		const waitOptions = (options: IDataObject): WaitOptions => ({
			wait: options.wait !== false,
			maxWaitMs: Number(options.maxWait ?? 300) * 1000,
		});

		const toItems = async (
			response: IDataObject | ParseFault,
			itemIndex: number,
			parser?: string,
		): Promise<INodeExecutionData[]> => {
			const pairedItem = { item: itemIndex };
			const body = response as IDataObject;
			if (body.state === 'pending') return [{ json: body, pairedItem }];
			const requestId = requestIdOf(body);
			const results = Array.isArray(body.results) ? (body.results as IDataObject[]) : [];
			if (!results.length) {
				return [{ json: { request_id: requestId, state: body.state, results: [] }, pairedItem }];
			}
			return await Promise.all(
				results.map(async (result, n) => {
					const json: IDataObject = { request_id: requestId, ...result };
					if (parser) json.parser = parser;
					const item: INodeExecutionData = { json, pairedItem };
					if (typeof result.screenshot === 'string') {
						delete json.screenshot;
						item.binary = {
							data: await this.helpers.prepareBinaryData(
								Buffer.from(result.screenshot, 'base64'),
								`screenshot-${n + 1}.png`,
								'image/png',
							),
						};
					}
					return item;
				}),
			);
		};

		/** Route a scraper that `/v1/scrapers` lists only in its asynchronous form. */
		const route = async (endpoint: string): Promise<string> => {
			if (endpoint.startsWith('async/')) return endpoint;
			const known = await scraperGroups();
			if (known && !known[`/v1/${endpoint}`] && known[`/v1/async/${endpoint}`]) {
				return `async/${endpoint}`;
			}
			return endpoint;
		};

		const search = async (itemIndex: number): Promise<INodeExecutionData[]> => {
			const query = (this.getNodeParameter('query', itemIndex) as string).trim();
			if (!query) throw new NodeOperationError(node, 'Query must not be empty', { itemIndex });
			const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
			const payload: IDataObject = {
				query,
				max_results: this.getNodeParameter('maxResults', itemIndex, 10),
			};
			const location = String(options.location ?? '').trim();
			if (location) payload.location = location.toUpperCase();
			const response = await apiRequest.call(this, 'POST', '/v1/search', payload);
			const body = check.call(this, response, '/v1/search', itemIndex);
			const results = Array.isArray(body.results) ? (body.results as IDataObject[]) : [];
			return results.map((result) => ({ json: result, pairedItem: { item: itemIndex } }));
		};

		const scrapeUrl = async (itemIndex: number): Promise<INodeExecutionData[]> => {
			const url = (this.getNodeParameter('url', itemIndex) as string).trim();
			if (!/^https?:\/\//i.test(url)) {
				throw new NodeOperationError(node, `URL must be an absolute http(s) URL, got "${url}"`, {
					itemIndex,
				});
			}
			const format = this.getNodeParameter('format', itemIndex) as string;
			const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
			const payload: IDataObject = { url, output: [format] };
			const location = String(options.location ?? '').trim();
			if (location) payload.location = location.toUpperCase();
			if (options.device) payload.device = options.device;
			// The API only screenshots a rendered page.
			if (options.runJs || format === 'screenshot') payload.run_js = true;
			if (format === 'json') payload.json = fieldsSpec(itemIndex);
			const response = await runScrape.call(
				this,
				'scrape',
				payload,
				waitOptions(options),
				itemIndex,
			);
			return await toItems(response, itemIndex, format === 'json' ? 'ai' : undefined);
		};

		const runScraper = async (itemIndex: number): Promise<INodeExecutionData[]> => {
			const scraper = this.getNodeParameter('scraper', itemIndex) as string;
			const endpoint = await route(endpointName(node, scraper, itemIndex));
			const params = parseObject(
				node,
				this.getNodeParameter('parameters', itemIndex),
				'Parameters',
				itemIndex,
			);
			const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
			const wait = waitOptions(options);

			if (this.getNodeParameter('output', itemIndex) === 'content') {
				return await toItems(
					await runScrape.call(this, endpoint, params, wait, itemIndex),
					itemIndex,
				);
			}

			const group = (await scraperGroups())?.[`/v1/${endpoint}`];
			if (group === JSON_NOT_SUPPORTED) {
				throw new NodeOperationError(node, `${endpoint} cannot return structured JSON`, {
					description: 'Set Output to "As in Parameters" and read the content instead.',
					itemIndex,
				});
			}
			const base: IDataObject = { ...params, output: jsonOutput(params.output) };
			delete base.json;
			const viaAi = async (spec: IDataObject) =>
				await toItems(
					await runScrape.call(this, endpoint, { ...base, json: spec }, wait, itemIndex),
					itemIndex,
					'ai',
				);

			if (this.getNodeParameter('parser', itemIndex) === 'ai') {
				return await viaAi(fieldsSpec(itemIndex));
			}

			const fallback = String(options.fallbackPrompt ?? '').trim();
			if (group === AI_ONLY) {
				if (fallback) return await viaAi({ prompt: fallback });
				throw new NodeOperationError(node, `${endpoint} has no dedicated parser`, {
					description: 'Choose the AI parser, or set AI Fallback Prompt in the options.',
					itemIndex,
				});
			}

			const response = await runScrape.call(this, endpoint, base, wait, itemIndex, !!fallback);
			if (fallback) {
				const finished = !isParseFault(response) && response.state !== 'pending';
				if (isParseFault(response) || (finished && jsonEmpty(response))) {
					return await viaAi({ prompt: fallback });
				}
			}
			return await toItems(response, itemIndex, 'dedicated');
		};

		const getParameters = async (itemIndex: number): Promise<INodeExecutionData[]> => {
			const scraper = this.getNodeParameter('scraper', itemIndex) as string;
			const endpoint = await route(endpointName(node, scraper, itemIndex));
			const path = `/v1/${endpoint}?format=json_schema`;
			// The API serves a scraper's schema only on OPTIONS, which n8n's method type leaves out.
			const method = 'OPTIONS' as IHttpRequestMethods;
			const body = check.call(this, await apiRequest.call(this, method, path), path, itemIndex);
			return [{ json: body, pairedItem: { item: itemIndex } }];
		};

		const getResult = async (itemIndex: number): Promise<INodeExecutionData[]> => {
			const requestId = (this.getNodeParameter('requestId', itemIndex) as string).trim();
			if (!/^\d+$/.test(requestId)) {
				throw new NodeOperationError(node, `"${requestId}" is not a request ID`, {
					description: 'Use the request_id a queued scrape returned.',
					itemIndex,
				});
			}
			const body = await collect.call(this, requestId, itemIndex);
			if ((body as IDataObject).state === 'pending') {
				return [{ json: pending(requestId), pairedItem: { item: itemIndex } }];
			}
			return await toItems(body, itemIndex);
		};

		const handlers: Record<string, (itemIndex: number) => Promise<INodeExecutionData[]>> = {
			'search:search': search,
			'scrape:scrapeUrl': scrapeUrl,
			'scraper:run': runScraper,
			'scraper:getParameters': getParameters,
			'request:getResult': getResult,
		};

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const handler = handlers[`${resource}:${operation}`];
				if (!handler) {
					throw new NodeOperationError(node, `Unsupported operation "${operation}"`, {
						itemIndex,
					});
				}
				returnData.push(...(await handler(itemIndex)));
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw asNodeError(node, error, itemIndex);
			}
		}

		return [returnData];
	}
}
