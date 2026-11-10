import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

import { version } from '../../package.json';

export const BASE_URL = 'https://webapi.oxylabs.io';
const CREDENTIAL = 'oxylabsWebApi';
const SDK_HEADER = `oxylabs-web-api-n8n/${version} (n8n)`;

const HTTP_TIMEOUT_MS = 200_000;
const RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;
export const POLL_MS = 5_000;
const RETRY_STATUS = [429, 500, 502, 503, 504];
// Queueing is not idempotent: resend only when the API certainly did not take the request.
const QUEUE_RETRY_STATUS = [429, 503];
const TIMEOUT_TITLE = 'REQUEST_FAILED_SCRAPE_TIMEOUT';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

export interface ApiResponse {
	status: number;
	body?: IDataObject;
	/** The request outlived the synchronous call: the API's own timeout or ours. */
	timedOut: boolean;
	/** Set when no HTTP response arrived at all. */
	transportError?: string;
}

/** A faulted request whose `title` names a parser failure, e.g. `PARSE_FAILED`. */
export interface ParseFault {
	parseFault: string;
}

export interface WaitOptions {
	wait: boolean;
	maxWaitMs: number;
}

function isObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isParseFault(value: IDataObject | ParseFault): value is ParseFault {
	return typeof (value as ParseFault).parseFault === 'string';
}

function isClientTimeout(error: { code?: string; message?: string }): boolean {
	return (
		error.code === 'ECONNABORTED' ||
		error.code === 'ETIMEDOUT' ||
		/timeout/i.test(error.message ?? '')
	);
}

async function send(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject | undefined,
	slowIsTimeout: boolean,
): Promise<ApiResponse> {
	try {
		const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
			method,
			url: `${BASE_URL}${path}`,
			body,
			json: true,
			headers: { 'x-oxylabs-sdk': SDK_HEADER },
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: HTTP_TIMEOUT_MS,
		})) as { statusCode: number; body: unknown };
		const parsed = isObject(response.body) ? response.body : undefined;
		const timedOut =
			parsed?.title === TIMEOUT_TITLE || (slowIsTimeout && response.statusCode === 504);
		return { status: response.statusCode, body: parsed, timedOut };
	} catch (error) {
		// Only the code and message are kept: the error object also carries the request,
		// and with it the Authorization header.
		const { code, message } = error as { code?: string; message?: string };
		if (slowIsTimeout && isClientTimeout({ code, message })) {
			return { status: 0, timedOut: true };
		}
		return { status: 0, timedOut: false, transportError: code ?? message ?? 'unknown error' };
	}
}

function state(body: IDataObject | undefined): unknown {
	return body?.state;
}

function quotaSpent(response: ApiResponse): boolean {
	return response.status === 429 && response.body?.title === 'QUOTA_EXCEEDED';
}

/**
 * Call the Web API, retrying transient failures (429, 5xx, no response) with backoff.
 *
 * A timed-out or faulted request is a verdict, not a transient error, so it is returned as is.
 * `slowIsTimeout` makes a gateway 504 or our own timeout count as a timeout, for scrapes that
 * get queued when they are slow.
 */
export async function apiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	{ slowIsTimeout = false, idempotent = true } = {},
): Promise<ApiResponse> {
	const retryStatus = idempotent ? RETRY_STATUS : QUEUE_RETRY_STATUS;
	for (let attempt = 0; ; attempt++) {
		if (attempt) {
			// Full jitter, so parallel items that hit the same 429 do not retry in lockstep.
			await sleep(Math.random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
		}
		const response = await send.call(this, method, path, body, slowIsTimeout);
		const retryable =
			!response.timedOut &&
			state(response.body) !== 'faulted' &&
			!quotaSpent(response) &&
			((idempotent && response.transportError !== undefined) ||
				retryStatus.includes(response.status));
		if (!retryable || attempt >= RETRIES) {
			return response;
		}
	}
}

function detail(body: IDataObject | undefined): string {
	if (!body) return '';
	// Validation problems name each bad field in `errors`; other problems carry `detail`.
	if (Array.isArray(body.errors) && body.errors.length) {
		return (body.errors as IDataObject[])
			.map((e) => [e.pointer, e.detail].filter(Boolean).join(': '))
			.join('; ');
	}
	return String(body.detail ?? body.message ?? body.title ?? '').slice(0, 500);
}

function requestIdOf(body: IDataObject | undefined): string | undefined {
	const metadata = isObject(body?.metadata) ? body.metadata : undefined;
	const id = metadata?.request_id ?? body?.request_id;
	return id === undefined || id === null ? undefined : String(id);
}

/**
 * The body of a successful response, or a NodeApiError whose message says what to do next.
 * With `allowParseFault`, a parser failure is returned instead of thrown, so the caller can
 * fall back to another parser.
 */
export function settle(
	this: Context,
	response: ApiResponse,
	path: string,
	itemIndex: number | undefined,
	allowParseFault = false,
): IDataObject | ParseFault {
	const { status, body } = response;
	const fail = (message: string, description?: string): never => {
		throw new NodeApiError(this.getNode(), (body ?? { message }) as JsonObject, {
			message,
			description,
			httpCode: status ? String(status) : undefined,
			itemIndex,
		});
	};

	if (response.transportError !== undefined) {
		fail(`Could not reach the Oxylabs Web API (${response.transportError})`);
	}
	if (response.timedOut) {
		fail(`${path} timed out`);
	}
	if (status === 401) {
		fail('Authentication failed (401)', 'Check the API key in the Oxylabs Web API credential.');
	}
	if (quotaSpent(response)) {
		fail(
			'Quota exceeded (429)',
			"The plan's quota is spent. Check the plan in the Oxylabs dashboard; retrying will not help.",
		);
	}
	if (status === 429) {
		fail(
			'Rate limited (429)',
			'Still limited after retries. Lower the concurrency, or check the remaining quota in the Oxylabs dashboard.',
		);
	}
	if (body && state(body) === 'faulted') {
		const tag = String(body.title ?? '');
		if (allowParseFault && tag.startsWith('PARSE_')) {
			return { parseFault: tag };
		}
		const reason = [tag, String(body.detail ?? '')].filter(Boolean).join(': ');
		fail(
			`The request failed (${reason || 'no reason given'})`,
			`Faulted requests are not charged. If it keeps failing, quote request_id ${requestIdOf(body) ?? 'unknown'} to Oxylabs support.`,
		);
	}
	if (status >= 400) {
		fail(`${path} returned ${status}${detail(body) ? `: ${detail(body)}` : ''}`);
	}
	if (!body) {
		fail(`${path} returned an empty response`);
	}
	return body as IDataObject;
}

/** Like `settle`, for calls whose result can never be a parser failure. */
export function check(
	this: Context,
	response: ApiResponse,
	path: string,
	itemIndex?: number,
): IDataObject {
	return settle.call(this, response, path, itemIndex) as IDataObject;
}

function asyncPath(endpoint: string): string {
	return endpoint.startsWith('async/') ? endpoint : `async/${endpoint}`;
}

export function pending(requestId: string): IDataObject {
	return {
		request_id: requestId,
		state: 'pending',
		note: 'Still running. Fetch it later with the Request > Get Result operation.',
	};
}

/** Queue a scrape on the API's asynchronous endpoint and return its request id. */
async function enqueue(
	this: IExecuteFunctions,
	endpoint: string,
	payload: IDataObject,
	itemIndex: number,
): Promise<string> {
	const path = `/v1/${asyncPath(endpoint)}`;
	const response = await apiRequest.call(this, 'POST', path, payload, { idempotent: false });
	const body = check.call(this, response, path, itemIndex);
	const requestId = requestIdOf(body);
	if (!requestId) {
		throw new NodeApiError(this.getNode(), body as JsonObject, {
			message: `${path} accepted the request but returned no request_id`,
			itemIndex,
		});
	}
	return requestId;
}

/** Read a queued request once: its result when done, or its pending state. */
export async function collect(
	this: IExecuteFunctions,
	requestId: string,
	itemIndex: number,
	allowParseFault = false,
): Promise<IDataObject | ParseFault> {
	// Every /v1/async/... request, whatever endpoint queued it, is read from this one path.
	const path = `/v1/async/scrape/${requestId}`;
	const response = await apiRequest.call(this, 'GET', path);
	if (response.status === 404) {
		throw new NodeApiError(this.getNode(), (response.body ?? {}) as JsonObject, {
			message: `No request ${requestId}`,
			description:
				'The API does not know this request id: it expired, or it was never a valid one. Run the scrape again.',
			httpCode: '404',
			itemIndex,
		});
	}
	return settle.call(this, response, path, itemIndex, allowParseFault);
}

async function waitFor(
	this: IExecuteFunctions,
	requestId: string,
	{ wait, maxWaitMs }: WaitOptions,
	itemIndex: number,
	allowParseFault: boolean,
): Promise<IDataObject | ParseFault> {
	if (!wait) return pending(requestId);
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		await sleep(POLL_MS);
		const result = await collect.call(this, requestId, itemIndex, allowParseFault);
		if (isParseFault(result) || state(result) !== 'pending') return result;
		if (Date.now() + POLL_MS > deadline) return pending(requestId);
	}
}

/**
 * Run a scrape synchronously, and queue it only if the synchronous call times out.
 *
 * Most pages finish inside the synchronous call, so it is always tried first. A timeout is not
 * resent there: the same payload goes to the asynchronous endpoint, and the node waits for it
 * (up to `maxWaitMs`) or hands back the request id. Endpoints that exist only in asynchronous
 * form (`async/...`) are always queued.
 */
export async function runScrape(
	this: IExecuteFunctions,
	endpoint: string,
	payload: IDataObject,
	waitOptions: WaitOptions,
	itemIndex: number,
	allowParseFault = false,
): Promise<IDataObject | ParseFault> {
	if (!endpoint.startsWith('async/')) {
		const path = `/v1/${endpoint}`;
		const response = await apiRequest.call(this, 'POST', path, payload, { slowIsTimeout: true });
		if (!response.timedOut) {
			return settle.call(this, response, path, itemIndex, allowParseFault);
		}
	}
	const requestId = await enqueue.call(this, endpoint, payload, itemIndex);
	return await waitFor.call(this, requestId, waitOptions, itemIndex, allowParseFault);
}

/** The request id a response carries, for the output items. */
export { requestIdOf };
