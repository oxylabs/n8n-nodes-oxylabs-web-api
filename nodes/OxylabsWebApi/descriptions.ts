import type { INodeProperties } from 'n8n-workflow';

const show = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

const waitOptions: INodeProperties[] = [
	{
		displayName: 'Wait for Queued Results',
		name: 'wait',
		type: 'boolean',
		default: true,
		description:
			'Whether to wait for a scrape that outlived the synchronous call and was queued. If off, or if the wait runs out, the item carries a request_id for Request > Get Result.',
	},
	{
		displayName: 'Max Wait (Seconds)',
		name: 'maxWait',
		type: 'number',
		typeOptions: { minValue: 5 },
		default: 300,
		description: 'How long to wait for a queued scrape before handing back its request_id',
	},
];

const fieldsDescription = (
	resource: string,
	operation: string,
	extra: object,
): INodeProperties[] => [
	{
		displayName: 'Describe Fields With',
		name: 'describeWith',
		type: 'options',
		options: [
			{
				name: 'Prompt',
				value: 'prompt',
				description: 'Name the fields in plain words',
			},
			{
				name: 'JSON Schema',
				value: 'schema',
				description: 'Give the exact shape the result must follow',
			},
		],
		default: 'prompt',
		displayOptions: { show: { resource: [resource], operation: [operation], ...extra } },
	},
	{
		displayName: 'Prompt',
		name: 'jsonPrompt',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		placeholder: 'e.g. the product title, the price and a list of image links',
		description: 'The fields to pull out of the page, for the AI parser',
		displayOptions: {
			show: { resource: [resource], operation: [operation], describeWith: ['prompt'], ...extra },
		},
	},
	{
		displayName: 'JSON Schema',
		name: 'jsonSchema',
		type: 'json',
		required: true,
		default: '{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" }\n  }\n}',
		description: 'A JSON Schema the AI parser output must follow',
		displayOptions: {
			show: { resource: [resource], operation: [operation], describeWith: ['schema'], ...extra },
		},
	},
];

export const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Request', value: 'request' },
		{ name: 'Scrape', value: 'scrape' },
		{ name: 'Scraper', value: 'scraper' },
		{ name: 'Search', value: 'search' },
	],
	default: 'search',
};

export const operationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['search'] } },
		options: [
			{
				name: 'Search the Web',
				value: 'search',
				description: 'Search the live web and get ranked organic results',
				action: 'Search the web',
			},
		],
		default: 'search',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['scrape'] } },
		options: [
			{
				name: 'Scrape a URL',
				value: 'scrapeUrl',
				description: 'Read any page, including JavaScript-heavy and bot-protected ones',
				action: 'Scrape a URL',
			},
		],
		default: 'scrapeUrl',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['scraper'] } },
		options: [
			{
				name: 'Get Parameters',
				value: 'getParameters',
				description: 'Get the JSON Schema of the parameters a scraper accepts',
				action: 'Get the parameters of a scraper',
			},
			{
				name: 'Run',
				value: 'run',
				description: 'Run a dedicated scraper, such as Amazon search or Google search',
				action: 'Run a scraper',
			},
		],
		default: 'run',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['request'] } },
		options: [
			{
				name: 'Get Result',
				value: 'getResult',
				description: 'Get the result of a queued scrape by its request ID',
				action: 'Get the result of a queued request',
			},
		],
		default: 'getResult',
	},
];

export const searchProperties: INodeProperties[] = [
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. eu ai act compliance deadlines',
		description: 'What to search for. Keyword-shaped queries work better than sentences.',
		displayOptions: show('search', ['search']),
	},
	{
		displayName: 'Max Results',
		name: 'maxResults',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 20 },
		default: 10,
		description: 'Maximum number of results to return (1-20). The response may contain fewer.',
		displayOptions: show('search', ['search']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('search', ['search']),
		options: [
			{
				displayName: 'Country',
				name: 'location',
				type: 'string',
				default: '',
				placeholder: 'e.g. DE',
				description: 'Two-letter country code (ISO 3166-1 alpha-2) to rank the results for',
			},
		],
	},
];

export const scrapeProperties: INodeProperties[] = [
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com',
		description: 'Absolute http(s) URL of the page to read',
		displayOptions: show('scrape', ['scrapeUrl']),
	},
	{
		displayName: 'Format',
		name: 'format',
		type: 'options',
		options: [
			{
				name: 'Markdown',
				value: 'markdown',
				description: 'The page as Markdown: far smaller than HTML, structure intact',
			},
			{
				name: 'HTML',
				value: 'html',
				description: 'The page source',
			},
			{
				name: 'Screenshot',
				value: 'screenshot',
				description: 'A PNG of the rendered page, as binary data',
			},
			{
				name: 'Structured Data (JSON)',
				value: 'json',
				description: 'The fields you describe, pulled out by the AI parser',
			},
		],
		default: 'markdown',
		displayOptions: show('scrape', ['scrapeUrl']),
	},
	...fieldsDescription('scrape', 'scrapeUrl', { format: ['json'] }),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('scrape', ['scrapeUrl']),
		options: [
			{
				displayName: 'Country',
				name: 'location',
				type: 'string',
				default: '',
				placeholder: 'e.g. DE',
				description:
					'Two-letter country code to fetch the page from, for pages that vary by country',
			},
			{
				displayName: 'Device',
				name: 'device',
				type: 'options',
				options: [
					{ name: 'Desktop', value: 'desktop' },
					{ name: 'Mobile', value: 'mobile' },
				],
				default: 'desktop',
			},
			{
				displayName: 'Render JavaScript',
				name: 'runJs',
				type: 'boolean',
				default: false,
				description:
					'Whether to run the page JavaScript first. Needed for pages that render client-side. Slower; screenshots always render.',
			},
			...waitOptions,
		],
	},
];

export const scraperProperties: INodeProperties[] = [
	{
		displayName: 'Scraper Name or ID',
		name: 'scraper',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getScrapers' },
		required: true,
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		placeholder: 'e.g. scrape/amazon/search',
		displayOptions: show('scraper', ['run', 'getParameters']),
	},
	{
		displayName: 'Parameters',
		name: 'parameters',
		type: 'json',
		required: true,
		default: '{\n  "query": ""\n}',
		description:
			"The scraper's own request body. Get Parameters lists the keys it accepts and their types.",
		displayOptions: show('scraper', ['run']),
	},
	{
		displayName: 'Output',
		name: 'output',
		type: 'options',
		options: [
			{
				name: 'As in Parameters',
				value: 'content',
				description: 'The content the parameters ask for (HTML unless they set "output")',
			},
			{
				name: 'Structured Data (JSON)',
				value: 'json',
				description: 'Parsed JSON, by the dedicated parser or the AI parser',
			},
		],
		default: 'content',
		displayOptions: show('scraper', ['run']),
	},
	{
		displayName: 'Parser',
		name: 'parser',
		type: 'options',
		options: [
			{
				name: 'Dedicated',
				value: 'dedicated',
				description:
					'The scraper own parser: search results, products, sellers, hotels and the like, in a fixed shape',
			},
			{
				name: 'AI',
				value: 'ai',
				description: 'Pulls out the fields you describe',
			},
		],
		default: 'dedicated',
		displayOptions: { show: { resource: ['scraper'], operation: ['run'], output: ['json'] } },
	},
	...fieldsDescription('scraper', 'run', { output: ['json'], parser: ['ai'] }),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('scraper', ['run']),
		options: [
			{
				displayName: 'AI Fallback Prompt',
				name: 'fallbackPrompt',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				placeholder: 'e.g. the product title and price',
				description:
					'With the dedicated parser: the fields for the AI parser to pull out if the dedicated parser fails or returns nothing, or if the scraper has none',
			},
			...waitOptions,
		],
	},
];

export const requestProperties: INodeProperties[] = [
	{
		displayName: 'Request ID',
		name: 'requestId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 7525823891655106561',
		description: 'The request_id of a queued scrape',
		displayOptions: show('request', ['getResult']),
	},
];
