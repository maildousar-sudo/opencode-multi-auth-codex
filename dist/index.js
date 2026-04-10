import fs from 'node:fs';
import { syncAuthFromOpenCode } from './auth-sync.js';
import { completeAuthorizationFlow, createAuthorizationFlow, loginAccount, promptForCallbackUrl } from './auth.js';
import { extractRateLimitUpdate, getBlockingRateLimitResetAt, mergeRateLimits, parseRateLimitResetFromError, parseRetryAfterHeader } from './rate-limits.js';
import { getNextAccount, markAuthInvalid, markModelUnsupported, markRateLimited, markWorkspaceDeactivated } from './rotation.js';
import { getDefaultModels } from './models.js';
import { getForceState, isForceActive } from './force-mode.js';
import { getRuntimeSettings } from './settings.js';
import { listAccounts, updateAccount, loadStore } from './store.js';
import { DEFAULT_CONFIG } from './types.js';
import { Errors } from './errors.js';
const PROVIDER_ID = 'openai';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const URL_PATHS = {
    RESPONSES: '/responses',
    CODEX_RESPONSES: '/codex/responses'
};
const OPENAI_HEADERS = {
    BETA: 'OpenAI-Beta',
    ACCOUNT_ID: 'chatgpt-account-id',
    ORIGINATOR: 'originator',
    SESSION_ID: 'session_id',
    CONVERSATION_ID: 'conversation_id'
};
const OPENAI_HEADER_VALUES = {
    BETA_RESPONSES: 'responses=experimental',
    ORIGINATOR_CODEX: 'codex_cli_rs'
};
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
let pluginConfig = { ...DEFAULT_CONFIG };
function configure(config) {
    pluginConfig = { ...pluginConfig, ...config };
}
function decodeJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return null;
        const payload = parts[1];
        const decoded = Buffer.from(payload, 'base64').toString('utf-8');
        return JSON.parse(decoded);
    }
    catch {
        return null;
    }
}
function extractRequestUrl(input) {
    if (typeof input === 'string')
        return input;
    if (input instanceof URL)
        return input.toString();
    return input.url;
}
function rewriteUrlForCodex(url) {
    return url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}
function extractPathAndSearch(url) {
    try {
        const u = new URL(url);
        return `${u.pathname}${u.search}`;
    }
    catch {
    }
    const trimmed = String(url || '').trim();
    if (trimmed.startsWith('/'))
        return trimmed;
    const firstSlash = trimmed.indexOf('/');
    if (firstSlash >= 0)
        return trimmed.slice(firstSlash);
    return trimmed;
}
function toCodexBackendUrl(originalUrl) {
    const pathAndSearch = extractPathAndSearch(originalUrl);
    let mapped = pathAndSearch;
    if (mapped.includes(URL_PATHS.RESPONSES)) {
        mapped = mapped.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
    }
    else if (mapped.includes('/chat/completions')) {
        mapped = mapped.replace('/chat/completions', '/codex/chat/completions');
    }
    return new URL(mapped, CODEX_BASE_URL).toString();
}
function filterInput(input) {
    if (!Array.isArray(input))
        return input;
    return input
        .filter((item) => item?.type !== 'item_reference')
        .map((item) => {
        if (item && typeof item === 'object' && 'id' in item) {
            const { id, ...rest } = item;
            return rest;
        }
        return item;
    });
}
function normalizeModel(model) {
    if (!model)
        return 'gpt-5.1';
    const modelId = model.includes('/') ? model.split('/').pop() : model;
    const baseModel = modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, '');
    const preferLatestRaw = process.env.OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST;
    const preferLatest = preferLatestRaw === '1' || preferLatestRaw === 'true';
    if (preferLatest &&
        (baseModel === 'gpt-5.3-codex' || baseModel === 'gpt-5.2-codex' || baseModel === 'gpt-5-codex')) {
        const latestModel = (process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL || 'gpt-5.4').trim();
        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
            console.log(`[multi-auth] model map: ${baseModel} -> ${latestModel}`);
        }
        return latestModel;
    }
    return baseModel;
}
function ensureContentType(headers) {
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('content-type')) {
        responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
    }
    return responseHeaders;
}
function extractErrorMessage(payload, fallbackText = '') {
    if (!payload || typeof payload !== 'object') {
        return fallbackText;
    }
    const detailMessage = typeof payload?.detail?.message === 'string'
        ? payload.detail.message
        : typeof payload?.detail === 'string'
            ? payload.detail
            : '';
    const errorMessage = typeof payload?.error?.message === 'string'
        ? payload.error.message
        : '';
    const topLevelMessage = typeof payload?.message === 'string'
        ? payload.message
        : '';
    return detailMessage || errorMessage || topLevelMessage || fallbackText;
}
function resolveRateLimitedUntil(rateLimits, headers, errorText, fallbackCooldownMs, now = Date.now()) {
    const retryAfterUntil = parseRetryAfterHeader(headers.get('retry-after'), now) || 0;
    const windowResetUntil = getBlockingRateLimitResetAt(rateLimits, now) || 0;
    const messageResetUntil = parseRateLimitResetFromError(errorText, now) || 0;
    const fallbackUntil = now + fallbackCooldownMs;
    return Math.max(fallbackUntil, retryAfterUntil, windowResetUntil, messageResetUntil);
}
function parseSseStream(sseText) {
    const lines = sseText.split('\n');
    for (const line of lines) {
        if (!line.startsWith('data: '))
            continue;
        try {
            const data = JSON.parse(line.substring(6));
            if (data?.type === 'response.done' || data?.type === 'response.completed') {
                return data.response;
            }
        }
        catch {
        }
    }
    return null;
}
async function convertSseToJson(response, headers) {
    if (!response.body) {
        throw new Error('[multi-auth] Response has no body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        fullText += decoder.decode(value, { stream: true });
    }
    const finalResponse = parseSseStream(fullText);
    if (!finalResponse) {
        return new Response(fullText, {
            status: response.status,
            statusText: response.statusText,
            headers
        });
    }
    const jsonHeaders = new Headers(headers);
    jsonHeaders.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(finalResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: jsonHeaders
    });
}
const MultiAuthPlugin = async ({ client, $, serverUrl, project, directory }) => {
    return {
        auth: {
            provider: PROVIDER_ID,
            async loader(getAuth, provider) {
                await syncAuthFromOpenCode(getAuth);
                const accounts = listAccounts();
                if (accounts.length === 0) {
                    console.log('[multi-auth] No accounts configured. Run: opencode-multi-auth add <alias>');
                    return {};
                }
                const customFetch = async (input, init) => new Response('Not included in truncated artifact update');
                return {
                    apiKey: 'chatgpt-oauth',
                    baseURL: CODEX_BASE_URL,
                    fetch: customFetch
                };
            },
            methods: [
                {
                    label: 'ChatGPT OAuth (Multi-Account)',
                    type: 'oauth',
                    prompts: [
                        {
                            type: 'text',
                            key: 'alias',
                            message: 'Account alias (e.g., personal, work)',
                            placeholder: 'personal'
                        }
                    ],
                    authorize: async (inputs) => {
                        const alias = inputs?.alias || `account-${Date.now()}`;
                        const flow = await createAuthorizationFlow();
                        return {
                            url: flow.url,
                            method: 'auto',
                            instructions: `Login with your ChatGPT Plus/Pro account for "${alias}"`,
                            callback: async () => {
                                try {
                                    const account = await loginAccount(alias, flow);
                                    return {
                                        type: 'success',
                                        provider: PROVIDER_ID,
                                        refresh: account.refreshToken,
                                        access: account.accessToken,
                                        expires: account.expiresAt
                                    };
                                }
                                catch {
                                    return { type: 'failed' };
                                }
                            }
                        };
                    }
                },
                {
                    label: 'ChatGPT OAuth (Manual Callback)',
                    type: 'oauth',
                    prompts: [
                        {
                            type: 'text',
                            key: 'alias',
                            message: 'Account alias (e.g., personal, work)',
                            placeholder: 'personal'
                        }
                    ],
                    authorize: async (inputs) => {
                        const alias = inputs?.alias || `account-${Date.now()}`;
                        const flow = await createAuthorizationFlow();
                        return {
                            url: flow.url,
                            method: 'auto',
                            instructions: `If this OpenCode session is remote, complete login in your browser, then paste the full callback URL back into the terminal prompt for "${alias}".`,
                            callback: async () => {
                                try {
                                    const callbackUrl = await promptForCallbackUrl(alias, flow);
                                    const account = await completeAuthorizationFlow(alias, flow, callbackUrl);
                                    return {
                                        type: 'success',
                                        provider: PROVIDER_ID,
                                        refresh: account.refreshToken,
                                        access: account.accessToken,
                                        expires: account.expiresAt
                                    };
                                }
                                catch {
                                    return { type: 'failed' };
                                }
                            }
                        };
                    }
                },
                {
                    label: 'Skip (use existing accounts)',
                    type: 'api'
                }
            ]
        }
    };
};
export default MultiAuthPlugin;
//# sourceMappingURL=index.js.map
