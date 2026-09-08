import {
	ApplicationError,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';

/**
 * TestMu AI (Formerly LambdaTest) Agent
 *
 * A verified-community-node-compatible AI Agent tool that drives a real cloud
 * browser on TestMu AI / LambdaTest via the W3C WebDriver protocol over HTTP.
 *
 * The whole node is pure HTTP — no third-party deps, no Node built-ins, no
 * timers, no subprocess. Session state lives in n8n's workflow static data so
 * the same browser persists across multiple tool calls in one workflow run.
 *
 * Element interaction uses a ref-number system: snapshot tags each
 * interactive element with a `data-n8n-ref` attribute and returns a numbered
 * list. Click/type then reference elements by ref number, and we translate
 * back to the data attribute server-side via WebDriver's "find element".
 */

const HUB_URL_BY_REGION: Record<string, string> = {
	us: 'https://hub.lambdatest.com/wd/hub',
	eu: 'https://eu-hub.lambdatest.com/wd/hub',
};

// Sessions kept in workflow static data older than this get pruned on the
// next access. LambdaTest's cloud also idles them out server-side after ~90s,
// so this is mainly to keep n8n's static data tidy.
const SESSION_STALE_MS = 30 * 60 * 1000;

// Script run via WebDriver execute_script. Returns a numbered, filtered list
// of interactive elements and stamps each one with a `data-n8n-ref` attribute
// so subsequent click/type calls can find the same element via that selector.
const SNAPSHOT_SCRIPT = `
	const SELECTOR = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [tabindex="0"]';
	document.querySelectorAll('[data-n8n-ref]').forEach((el) => el.removeAttribute('data-n8n-ref'));
	const out = [];
	let nextRef = 1;
	for (const el of document.querySelectorAll(SELECTOR)) {
		const tag = el.tagName.toLowerCase();
		const inputType = (el.getAttribute('type') || '').toLowerCase();
		const isDisabled = ('disabled' in el && el.disabled) || el.getAttribute('aria-disabled') === 'true';
		const isHidden = el.getAttribute('aria-hidden') === 'true' || el.hidden || (tag === 'input' && inputType === 'hidden');
		if (isDisabled || isHidden) continue;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const inViewport = cy >= 0 && cy < window.innerHeight && cx >= 0 && cx < window.innerWidth;
		if (inViewport) {
			const top = document.elementFromPoint(cx, cy);
			if (top && !(top === el || el.contains(top) || top.contains(el))) continue;
		}
		const isReadOnly = 'readOnly' in el && el.readOnly;
		const baseRole = el.getAttribute('role') || tag;
		const role = isReadOnly ? baseRole + ' (readonly)' : baseRole;
		const text = (
			el.innerText ||
			el.value ||
			el.placeholder ||
			el.getAttribute('aria-label') ||
			el.getAttribute('title') ||
			''
		).replace(/\\s+/g, ' ').trim().slice(0, 120);
		const ref = nextRef++;
		el.setAttribute('data-n8n-ref', String(ref));
		out.push({ ref, tag, role, text });
	}
	return out;
`;

// W3C WebDriver returns elements wrapped under this magic key.
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

interface SnapshotItem {
	ref: number;
	tag: string;
	role: string;
	text: string;
}

interface StoredSession {
	sessionId: string;
	hubUrl: string;
	refs: SnapshotItem[];
	dashboardUrl: string;
	lastActivity: number;
}

interface StaticData {
	sessions?: Record<string, StoredSession>;
}

export class TestmuaiAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TestMu AI (Formerly LambdaTest) Agent',
		name: 'testmuaiAgent',
		icon: 'file:testmuai_logo.png',
		group: ['transform'],
		version: 1,
		description:
			'Give your AI agent a real browser to work with on TestMu AI Browser Cloud. Opens URLs, clicks elements, fills forms, and captures screenshots — all through a single tool. The live session is visible on the TestMu dashboard.',
		defaults: { name: 'TestMu AI (Formerly LambdaTest) Agent' },
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [{ name: 'testmuaiApi', required: true }],
		properties: [
			{
				displayName: 'Browser',
				name: 'browserName',
				type: 'options',
				default: 'Chrome',
				description: 'Browser the cloud session uses. Set once for the whole workflow.',
				options: [
					{ name: 'Chrome', value: 'Chrome' },
					{ name: 'Firefox', value: 'Firefox' },
					{ name: 'Microsoft Edge', value: 'MicrosoftEdge' },
					{ name: 'Safari', value: 'Safari' },
				],
			},
			{
				displayName: 'Platform',
				name: 'platformName',
				type: 'options',
				default: 'Windows 11',
				description: 'Operating system for the cloud session. Pick a platform compatible with the browser above.',
				options: [
					{ name: 'Linux', value: 'Linux' },
					{ name: 'macOS Monterey', value: 'macOS Monterey' },
					{ name: 'macOS Sequoia', value: 'macOS Sequoia' },
					{ name: 'macOS Sonoma', value: 'macOS Sonoma' },
					{ name: 'macOS Ventura', value: 'macOS Ventura' },
					{ name: 'Windows 10', value: 'Windows 10' },
					{ name: 'Windows 11', value: 'Windows 11' },
				],
			},
			{
				displayName: 'Browser Version',
				name: 'browserVersion',
				type: 'options',
				default: 'latest',
				description: '"latest" tracks the newest stable release; "latest-1" is one major version behind, and so on',
				options: [
					{ name: 'Beta', value: 'beta' },
					{ name: 'Dev', value: 'dev' },
					{ name: 'Latest', value: 'latest' },
					{ name: 'Latest - 1', value: 'latest-1' },
					{ name: 'Latest - 2', value: 'latest-2' },
					{ name: 'Latest - 3', value: 'latest-3' },
				],
			},
			{
				displayName: 'Region',
				name: 'region',
				type: 'options',
				default: 'us',
				description: 'TestMu cloud region. Pick whichever is closest to your users for lower latency.',
				options: [
					{ name: 'US', value: 'us' },
					{ name: 'EU', value: 'eu' },
				],
			},
			{
				displayName: 'Action',
				name: 'action',
				type: 'options',
				default: '={{ $fromAI("action", "What to do in the browser. One of: navigate, snapshot, click, type, get_text, screenshot, release. Call release when finished to free the cloud browser.", "string") }}',
				required: true,
				description: 'Filled automatically by the connected AI model',
				options: [
					{
						name: 'Click',
						value: 'click',
						description: 'Click an element by its ref number from the latest snapshot',
						action: 'Click an element by its ref number from the latest snapshot',
					},
					{
						name: 'Get Text',
						value: 'get_text',
						description: 'Read text from a specific ref or the whole page',
						action: 'Read text from a specific ref or the whole page',
					},
					{
						name: 'Navigate',
						value: 'navigate',
						description: 'Open a URL in the cloud browser',
						action: 'Open a URL in the cloud browser',
					},
					{
						name: 'Release',
						value: 'release',
						description: 'Release the cloud browser session. Call this when the goal is achieved to avoid billing for idle time.',
						action: 'Release the cloud browser session when finished',
					},
					{
						name: 'Screenshot',
						value: 'screenshot',
						description: 'Capture a base64 PNG of the current page (for vision models)',
						action: 'Capture a base64 png of the current page for vision models',
					},
					{
						name: 'Snapshot',
						value: 'snapshot',
						description: 'Get a numbered list of clickable / fillable elements on the current page',
						action: 'Get a numbered list of clickable / fillable elements on the current page',
					},
					{
						name: 'Type',
						value: 'type',
						description: 'Type text into an input element by ref',
						action: 'Type text into an input element by ref',
					},
				],
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '={{ $fromAI("url", "Absolute URL to open. Used when action=navigate; ignored otherwise.", "string") }}',
				placeholder: 'https://example.com',
				description: 'Filled by the AI when action=navigate',
			},
			{
				displayName: 'Ref',
				name: 'ref',
				type: 'number',
				// eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-number -- the default is an $fromAI() expression so the field reaches the tool schema; n8n resolves it to a number at runtime
				default:
					'={{ $fromAI("ref", "Ref number of the target element, taken from the most recent snapshot output. Required for click and type; optional for get_text. Run snapshot first to obtain refs.", "number", 0) }}',
				description: 'Filled by the AI for click, type, and (optionally) get_text. Refs come from the latest snapshot.',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '={{ $fromAI("text", "Text to type into the input element. Used when action=type.", "string") }}',
				description: 'Filled by the AI when action=type',
			},
			{
				displayName: 'Press Enter After Typing',
				name: 'submit',
				type: 'boolean',
				// eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-boolean -- the default is an $fromAI() expression so the field reaches the tool schema; n8n resolves it to a boolean at runtime
				default:
					'={{ $fromAI("submit", "Whether to press Enter after typing, e.g. to submit a search form. Used when action=type.", "boolean", false) }}',
				description: 'Whether to press Enter after typing (e.g. to submit a search). Filled by the AI when action=type.',
			},
			{
				displayName: 'Max Text Length',
				name: 'maxLength',
				type: 'number',
				default: 4000,
				description: 'Truncate get_text result to this many characters. User setting; not filled by the AI.',
			},
			{
				displayName: 'Full Page Screenshot',
				name: 'fullPage',
				type: 'boolean',
				// eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-boolean -- the default is an $fromAI() expression so the field reaches the tool schema; n8n resolves it to a boolean at runtime
				default:
					'={{ $fromAI("fullPage", "Whether to capture the entire scrollable page instead of just the viewport. Used when action=screenshot.", "boolean", false) }}',
				description: 'Whether to capture the entire scrollable page (true) or just the viewport (false). Filled by the AI when action=screenshot.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = (await this.getCredentials('testmuaiApi')) as {
			username: string;
			accessKey: string;
		};

		const out: INodeExecutionData[] = [];

		for (let i = 0; i < Math.max(items.length, 1); i++) {
			const action = this.getNodeParameter('action', i) as string;
			try {
				const session = await getOrCreateSession(this, i, credentials);
				const result = await dispatch(action, i, this, session, credentials);
				out.push({
					json: {
						action,
						sessionId: session.sessionId,
						dashboardUrl: session.dashboardUrl,
						...result,
					},
					pairedItem: { item: i },
				});
			} catch (err) {
				// Pass through n8n's own error types unchanged so reviewers and
				// users see properly formatted HTTP status, response body, and
				// headers from the upstream WebDriver Hub.
				if (err instanceof NodeApiError || err instanceof NodeOperationError) {
					throw err;
				}

				// HTTP failures from this.helpers.httpRequest carry statusCode /
				// httpCode / response fields. Surface those via NodeApiError so
				// the n8n UI shows the upstream context instead of a flat
				// "operation failed" string.
				const e = err as { statusCode?: number; httpCode?: string; response?: unknown };
				if (e.statusCode !== undefined || e.httpCode !== undefined || e.response !== undefined) {
					throw new NodeApiError(this.getNode(), err as JsonObject, { itemIndex: i });
				}

				// Anything else (internal validation / ApplicationError) stays
				// a NodeOperationError since it's not an API failure.
				throw new NodeOperationError(
					this.getNode(),
					`TestMu AI Agent (${action}) failed: ${(err as Error).message}`,
					{ itemIndex: i },
				);
			}
		}
		return [out];
	}
}

// --------------------------------------------------------------------------
// Session management — uses n8n workflow static data instead of in-memory
// state, so it survives across tool calls without breaking sandbox rules.
// --------------------------------------------------------------------------

async function getOrCreateSession(
	ctx: IExecuteFunctions,
	itemIndex: number,
	credentials: { username: string; accessKey: string },
): Promise<StoredSession> {
	const staticData = ctx.getWorkflowStaticData('node') as StaticData;
	if (!staticData.sessions) staticData.sessions = {};

	// Lazy cleanup of stale sessions — no setInterval needed.
	const now = Date.now();
	for (const key of Object.keys(staticData.sessions)) {
		if (now - staticData.sessions[key].lastActivity > SESSION_STALE_MS) {
			delete staticData.sessions[key];
		}
	}

	const executionId = ctx.getExecutionId() || 'noexec';
	const existing = staticData.sessions[executionId];
	if (existing) {
		existing.lastActivity = now;
		return existing;
	}

	const region = ctx.getNodeParameter('region', itemIndex, 'us') as string;
	const hubUrl = HUB_URL_BY_REGION[region] || HUB_URL_BY_REGION.us;

	const browserName = ctx.getNodeParameter('browserName', itemIndex, 'Chrome') as string;
	const platformName = ctx.getNodeParameter('platformName', itemIndex, 'Windows 11') as string;
	const browserVersion = ctx.getNodeParameter('browserVersion', itemIndex, 'latest') as string;

	const workflowName = ctx.getWorkflow().name || 'workflow';
	const stamp = new Date().toISOString().replace(/[:.T]/g, '-').slice(0, 19);
	const sessionName = `${workflowName}_${stamp}`;

	const response = (await ctx.helpers.httpRequest({
		method: 'POST',
		url: `${hubUrl}/session`,
		body: {
			capabilities: {
				alwaysMatch: {
					browserName,
					platformName,
					browserVersion,
					'LT:Options': {
						username: credentials.username,
						accessKey: credentials.accessKey,
						build: 'n8n-testmuai',
						name: sessionName,
						video: true,
						console: true,
					},
				},
			},
		},
		json: true,
	})) as { value: { sessionId: string } };

	const sessionId = response.value?.sessionId;
	if (!sessionId) {
		throw new ApplicationError('TestMu cloud did not return a session ID');
	}

	const stored: StoredSession = {
		sessionId,
		hubUrl,
		refs: [],
		dashboardUrl: `https://automation.lambdatest.com/test?testID=${sessionId}`,
		lastActivity: now,
	};
	staticData.sessions[executionId] = stored;
	return stored;
}

// --------------------------------------------------------------------------
// Action dispatch
// --------------------------------------------------------------------------

async function dispatch(
	action: string,
	itemIndex: number,
	ctx: IExecuteFunctions,
	session: StoredSession,
	_credentials: { username: string; accessKey: string },
): Promise<Record<string, unknown>> {
	switch (action) {
		case 'navigate': {
			const url = (ctx.getNodeParameter('url', itemIndex) as string).trim();
			if (!url) throw new ApplicationError('URL is required for navigate');
			await webdriver(ctx, session, 'POST', '/url', { url });
			await refreshSnapshot(ctx, session);
			return { snapshot: formatSnapshot(session) };
		}

		case 'snapshot': {
			await refreshSnapshot(ctx, session);
			return { snapshot: formatSnapshot(session), elements: session.refs as unknown as IDataObject[] };
		}

		case 'click': {
			const ref = Number(ctx.getNodeParameter('ref', itemIndex));
			const target = requireRef(session, ref);
			const elementId = await findElement(ctx, session, refSelector(ref));
			try {
				await webdriver(ctx, session, 'POST', `/element/${elementId}/click`, {});
			} catch (err) {
				// Fallback: programmatic click via execute_script bypasses
				// visibility checks if a transient overlay is in the way.
				const msg = (err as Error).message;
				if (/intercept|not clickable|not interactable|stale/i.test(msg)) {
					await webdriver(ctx, session, 'POST', '/execute/sync', {
						script: 'arguments[0].click();',
						args: [{ [ELEMENT_KEY]: elementId }],
					});
				} else {
					throw err;
				}
			}
			await refreshSnapshot(ctx, session);
			return {
				clicked: { ref, tag: target.tag, text: target.text },
				snapshot: formatSnapshot(session),
			};
		}

		case 'type': {
			const ref = Number(ctx.getNodeParameter('ref', itemIndex));
			const text = ctx.getNodeParameter('text', itemIndex) as string;
			const submit = ctx.getNodeParameter('submit', itemIndex, false) as boolean;
			requireRef(session, ref);
			const elementId = await findElement(ctx, session, refSelector(ref));

			// Clear existing value first so we don't append. WebDriver's clear
			// command is gentle and works on most inputs.
			await webdriver(ctx, session, 'POST', `/element/${elementId}/clear`, {}).catch(() => {
				// some elements (custom contenteditable, etc.) reject clear — ignore.
			});

			// Append the Enter key code (W3C: ) if submit was requested.
			const payload = submit ? text + '' : text;
			await webdriver(ctx, session, 'POST', `/element/${elementId}/value`, { text: payload });

			await refreshSnapshot(ctx, session);
			return {
				typed: { ref, text, submit },
				snapshot: formatSnapshot(session),
			};
		}

		case 'get_text': {
			const ref = Number(ctx.getNodeParameter('ref', itemIndex, 0));
			const maxLength = Number(ctx.getNodeParameter('maxLength', itemIndex, 4000));
			let text: string;
			if (ref && ref > 0) {
				requireRef(session, ref);
				const elementId = await findElement(ctx, session, refSelector(ref));
				const res = (await webdriver(ctx, session, 'GET', `/element/${elementId}/text`)) as {
					value?: string;
				};
				text = res.value ?? '';
			} else {
				const res = (await webdriver(ctx, session, 'POST', '/execute/sync', {
					script: 'return document.body.innerText || "";',
					args: [],
				})) as { value?: string };
				text = res.value ?? '';
			}
			const trimmed = text.replace(/\s+/g, ' ').trim();
			return {
				text: trimmed.slice(0, maxLength),
				length: trimmed.length,
				truncated: trimmed.length > maxLength,
			};
		}

		case 'screenshot': {
			// W3C WebDriver returns the viewport screenshot via GET /screenshot.
			// Full-page screenshots aren't in the W3C spec, so we emulate by
			// scrolling + stitching via JS — out of scope for v1. We return the
			// viewport-only screenshot and surface the fullPage flag so callers
			// can know if they asked for what they didn't get.
			const fullPage = ctx.getNodeParameter('fullPage', itemIndex, false) as boolean;
			const res = (await webdriver(ctx, session, 'GET', '/screenshot')) as { value?: string };
			return {
				image: res.value ?? '',
				fullPage: false,
				fullPageRequested: fullPage,
			};
		}

		case 'release': {
			// Cleanly end the WebDriver session so the dashboard shows the run
			// as "Completed" rather than "Idle Timeout". Also removes the
			// session from n8n's workflow static data so the agent can't
			// accidentally reuse a dead session ID on a subsequent call.
			await webdriver(ctx, session, 'DELETE', '').catch(() => {
				// session may already be gone server-side; ignore
			});
			const staticData = ctx.getWorkflowStaticData('node') as StaticData;
			const executionId = ctx.getExecutionId() || 'noexec';
			if (staticData.sessions) delete staticData.sessions[executionId];
			return { released: true };
		}

		default:
			throw new ApplicationError(`Unknown action: ${action}`);
	}
}

// --------------------------------------------------------------------------
// WebDriver REST helpers — all HTTP via n8n's sandboxed httpRequest.
// --------------------------------------------------------------------------

async function webdriver(
	ctx: IExecuteFunctions,
	session: StoredSession,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	body?: IDataObject,
): Promise<unknown> {
	const opts: IHttpRequestOptions = {
		method,
		url: `${session.hubUrl}/session/${session.sessionId}${path}`,
		json: true,
	};
	if (body !== undefined && method !== 'GET') opts.body = body;
	return ctx.helpers.httpRequest(opts);
}

async function findElement(
	ctx: IExecuteFunctions,
	session: StoredSession,
	selector: string,
): Promise<string> {
	const res = (await webdriver(ctx, session, 'POST', '/element', {
		using: 'css selector',
		value: selector,
	})) as { value?: Record<string, string> };
	const id = res.value?.[ELEMENT_KEY];
	if (!id) {
		throw new ApplicationError(`Could not find element matching ${selector}`);
	}
	return id;
}

async function refreshSnapshot(ctx: IExecuteFunctions, session: StoredSession): Promise<void> {
	const res = (await webdriver(ctx, session, 'POST', '/execute/sync', {
		script: SNAPSHOT_SCRIPT,
		args: [],
	})) as { value?: SnapshotItem[] };
	session.refs = res.value ?? [];
	session.lastActivity = Date.now();
}

function requireRef(session: StoredSession, ref: number): SnapshotItem {
	if (!Number.isInteger(ref) || ref < 1) {
		throw new ApplicationError(
			`Ref must be a positive integer, got ${ref}. Run the snapshot action first and use a ref number from its output.`,
		);
	}
	const target = session.refs.find((r) => r.ref === ref);
	if (!target) {
		throw new ApplicationError(
			`No element with ref ${ref}. Run snapshot to refresh refs (current count: ${session.refs.length}).`,
		);
	}
	return target;
}

function refSelector(ref: number): string {
	return `[data-n8n-ref="${ref}"]`;
}

function formatSnapshot(session: StoredSession): string {
	if (!session.refs.length) return '(no interactive elements found)';
	return session.refs.map((r) => `${r.ref}. <${r.tag}> [${r.role}] ${r.text}`).join('\n');
}
