import { normalizeBaseUrl, type ModelOption } from './modelService';
import {
  apiCallErrorMessage,
  isRecord,
  managementApi,
  readString,
  responseList,
} from './managementApi';
import {
  buildProviderHealthProbe,
  mergeProviderHealthModels,
  PROVIDER_HEALTH_TIMEOUT_MS,
} from './providerHealthCheck';
import {
  CODEX_CLIENT_FINGERPRINT_HEADERS,
  codexClientFingerprintHeaders,
} from './quotaService';

export const ANYROUTER_GRAB_MIN_INTERVAL_MS = 50;
export const ANYROUTER_GRAB_DEFAULT_INTERVAL_MS = 2_000;
export const ANYROUTER_GRAB_MAX_CONCURRENCY = 32;
export const ANYROUTER_GRAB_DEFAULT_CONCURRENCY = 1;
export const ANYROUTER_KEEPALIVE_MIN_MS = 3 * 60 * 1000;
export const ANYROUTER_KEEPALIVE_MAX_MS = 5 * 60 * 1000;

const FINGERPRINT_NAMES = Object.keys(CODEX_CLIENT_FINGERPRINT_HEADERS) as Array<
  keyof typeof CODEX_CLIENT_FINGERPRINT_HEADERS
>;

export type OpenAiProviderMatch = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

export type GrabDecision =
  | { action: 'retry' }
  | { action: 'continue' }
  | { action: 'success' }
  | { action: 'stop'; reason: 'auth' | 'missing-fingerprint' };

export type GrabStopReason =
  | 'success'
  | 'auth'
  | 'other'
  | 'missing-fingerprint'
  | 'missing-key'
  | 'missing-url'
  | 'missing-model'
  | 'request-failed'
  | 'enable-failed'
  | 'disable-failed'
  | 'aborted';

export type GrabStatusUpdate = {
  phase: 'running' | 'succeeded' | 'stopped';
  status: number | null;
  reason: GrabStopReason | 'busy';
  detail: string;
  attempts: number;
};

export type GrabLoopResult = {
  phase: 'succeeded' | 'stopped';
  status: number | null;
  reason: GrabStopReason;
  detail: string;
  attempts: number;
};

export function formatGrabElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

const headerValue = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';

export function isAnyRouterBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  try {
    const hostname = new URL(normalizeBaseUrl(trimmed)).hostname.toLowerCase();
    return hostname === 'anyrouter.top' || hostname.endsWith('.anyrouter.top');
  } catch {
    return false;
  }
}

/** Configured model names 健康检测 already lists for this provider. Nothing is chosen. */
export function anyRouterGrabModels(models: ModelOption[]): string[] {
  return mergeProviderHealthModels([], models)
    .map((model) => model.name.trim())
    .filter(Boolean);
}

const CODEX_FINGERPRINT_HEADER_NAMES = new Set(
  Object.keys(CODEX_CLIENT_FINGERPRINT_HEADERS).map((name) => name.toLowerCase()),
);

/**
 * Drop any client-identity header, including a differently cased CPA User-Agent,
 * then apply the Codex fingerprint. Header.Set in CPA's /requests/api-call
 * canonicalizes names, so a leftover `user-agent` would replace `User-Agent`.
 */
export function headersWithCodexFingerprint(
  headers: Record<string, string>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  Object.entries(headers).forEach(([name, value]) => {
    if (CODEX_FINGERPRINT_HEADER_NAMES.has(name.toLowerCase())) return;
    kept[name] = value;
  });
  return { ...kept, ...codexClientFingerprintHeaders() };
}

/** Chat-completions probe 健康检测 already builds for an OpenAI-compatible base. */
export function buildAnyRouterGrabProbe(
  baseUrl: string,
  model: string,
  apiKey: string,
  customHeaders: Record<string, string> = {},
) {
  if (!baseUrl.trim()) throw new Error('missing base url');
  if (!model.trim()) throw new Error('missing model');
  return buildProviderHealthProbe(
    'openai',
    baseUrl,
    model,
    apiKey,
    '',
    headersWithCodexFingerprint(customHeaders),
  );
}

/** Same chat probe as a grab, with a short random user message. */
export function buildAnyRouterKeepaliveProbe(
  baseUrl: string,
  model: string,
  apiKey: string,
  content: string,
  customHeaders: Record<string, string> = {},
) {
  const message = content.trim();
  if (!message) throw new Error('missing content');
  const probe = buildAnyRouterGrabProbe(baseUrl, model, apiKey, customHeaders);
  const body = JSON.parse(probe.data) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: boolean;
  };
  body.messages = [{ role: 'user', content: message }];
  return { ...probe, data: JSON.stringify(body) };
}

export function nextKeepaliveDelayMs(random: () => number = Math.random): number {
  const unit = Math.min(1, Math.max(0, random()));
  const span = ANYROUTER_KEEPALIVE_MAX_MS - ANYROUTER_KEEPALIVE_MIN_MS;
  return ANYROUTER_KEEPALIVE_MIN_MS + Math.round(unit * span);
}

export function randomKeepaliveContent(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    const unit = Math.min(0.999999, Math.max(0, random()));
    body += alphabet[Math.floor(unit * alphabet.length)] ?? 'a';
  }
  return body;
}

export function clampGrabIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return ANYROUTER_GRAB_DEFAULT_INTERVAL_MS;
  return Math.max(ANYROUTER_GRAB_MIN_INTERVAL_MS, Math.round(value));
}

export function clampGrabConcurrency(value: number): number {
  if (!Number.isFinite(value)) return ANYROUTER_GRAB_DEFAULT_CONCURRENCY;
  return Math.min(ANYROUTER_GRAB_MAX_CONCURRENCY, Math.max(1, Math.round(value)));
}

export function anyRouterGrabHeaders(apiKey: string): Record<string, string> {
  return {
    ...codexClientFingerprintHeaders(),
    Authorization: `Bearer ${apiKey.trim()}`,
  };
}

export function grabRequestHasCodexFingerprint(headers: Record<string, string>): boolean {
  return FINGERPRINT_NAMES.every((name) => headerValue(headers, name) === CODEX_CLIENT_FINGERPRINT_HEADERS[name]);
}

export function classifyGrabStatus(status: number, fingerprintPresent: boolean): GrabDecision {
  if (status === 200) {
    return fingerprintPresent
      ? { action: 'success' }
      : { action: 'stop', reason: 'missing-fingerprint' };
  }
  if (status === 500) return { action: 'retry' };
  if (status === 401 || status === 403) return { action: 'stop', reason: 'auth' };
  return { action: 'continue' };
}

export function readGrabStatusCode(response: Record<string, unknown>): number {
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  return Number.isFinite(status) ? status : 0;
}

function openAiRecordKeys(record: Record<string, unknown>): string[] {
  const entries = Array.isArray(record['api-key-entries'])
    ? record['api-key-entries'].filter(isRecord)
    : [];
  const fromEntries = entries
    .map((entry) => readString(entry, 'api-key', 'apiKey'))
    .filter(Boolean);
  if (fromEntries.length > 0) return fromEntries;
  const single = readString(record, 'api-key', 'apiKey');
  return single ? [single] : [];
}

export function findOpenAiCompatibilityIndex(
  records: Record<string, unknown>[],
  match: OpenAiProviderMatch,
): number {
  let base = '';
  try {
    base = normalizeBaseUrl(match.baseUrl);
  } catch {
    return -1;
  }
  const key = match.apiKey.trim();
  const name = match.name.trim();
  return records.findIndex((record) => {
    const recordBase = readString(record, 'base-url', 'baseUrl');
    let normalized = '';
    try {
      normalized = recordBase ? normalizeBaseUrl(recordBase) : '';
    } catch {
      return false;
    }
    if (normalized !== base) return false;
    if (name && readString(record, 'name') !== name) return false;
    return openAiRecordKeys(record).includes(key);
  });
}

export async function setOpenAiCompatibilityProviderDisabled(
  match: OpenAiProviderMatch,
  disabled: boolean,
): Promise<void> {
  const payload = await managementApi.get('/openai-compatibility');
  const records = responseList(payload, 'openai-compatibility');
  const index = findOpenAiCompatibilityIndex(records, match);
  if (index < 0) throw new Error('OpenAI compatibility entry no longer exists');
  await managementApi.patch('/openai-compatibility', {
    index,
    value: { disabled },
  });
}

/** Enables the saved provider. CLIProxyAPI then includes it in the routing client set. */
export async function enableOpenAiCompatibilityProvider(match: OpenAiProviderMatch): Promise<void> {
  await setOpenAiCompatibilityProviderDisabled(match, false);
}

export function waitForGrabInterval(ms: number, signal: AbortSignal): Promise<void> {
  const delay = clampGrabIntervalMs(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort);
  });
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function runAnyRouterGrabLoop(options: {
  baseUrl: string;
  apiKey: string;
  providerName: string;
  model: string;
  customHeaders?: Record<string, string>;
  intervalMs: number;
  concurrency?: number;
  signal: AbortSignal;
  onStatus?: (update: GrabStatusUpdate) => void;
  onAttempt?: (attempts: number) => void;
  onDisabled?: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<GrabLoopResult> {
  const sleep = options.sleep ?? waitForGrabInterval;
  const publish = (result: GrabLoopResult): GrabLoopResult => {
    if (options.signal.aborted && result.reason !== 'success') {
      return {
        phase: 'stopped',
        status: result.status,
        reason: 'aborted',
        detail: result.detail,
        attempts: result.attempts,
      };
    }
    options.onStatus?.({
      phase: result.phase === 'succeeded' ? 'succeeded' : 'stopped',
      status: result.status,
      reason: result.reason,
      detail: result.detail,
      attempts: result.attempts,
    });
    return result;
  };

  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    return publish({ phase: 'stopped', status: null, reason: 'missing-key', detail: '', attempts: 0 });
  }
  if (!options.baseUrl.trim()) {
    return publish({ phase: 'stopped', status: null, reason: 'missing-url', detail: '', attempts: 0 });
  }

  let probe;
  try {
    probe = buildAnyRouterGrabProbe(options.baseUrl, options.model, apiKey, options.customHeaders);
  } catch (error) {
    const message = errorText(error);
    if (message === 'missing model') {
      return publish({ phase: 'stopped', status: null, reason: 'missing-model', detail: '', attempts: 0 });
    }
    return publish({
      phase: 'stopped',
      status: null,
      reason: 'missing-url',
      detail: message === 'missing base url' ? '' : message,
      attempts: 0,
    });
  }
  if (!probe.url) {
    return publish({ phase: 'stopped', status: null, reason: 'missing-url', detail: '', attempts: 0 });
  }
  if (!grabRequestHasCodexFingerprint(probe.header)) {
    return publish({ phase: 'stopped', status: null, reason: 'missing-fingerprint', detail: '', attempts: 0 });
  }

  try {
    await setOpenAiCompatibilityProviderDisabled({
      name: options.providerName,
      baseUrl: options.baseUrl,
      apiKey,
    }, true);
    options.onDisabled?.();
  } catch (error) {
    return publish({
      phase: 'stopped',
      status: null,
      reason: 'disable-failed',
      detail: errorText(error),
      attempts: 0,
    });
  }
  if (options.signal.aborted) {
    return { phase: 'stopped', status: null, reason: 'aborted', detail: '', attempts: 0 };
  }

  const intervalMs = clampGrabIntervalMs(options.intervalMs);
  const workerCount = clampGrabConcurrency(options.concurrency ?? ANYROUTER_GRAB_DEFAULT_CONCURRENCY);
  const stopAll = new AbortController();
  const abortStopAll = () => stopAll.abort();
  if (options.signal.aborted) stopAll.abort();
  else options.signal.addEventListener('abort', abortStopAll, { once: true });

  const gate: { claimed: boolean; terminal: GrabLoopResult | null; attempts: number } = {
    claimed: false,
    terminal: null,
    attempts: 0,
  };
  const countAttempt = () => {
    gate.attempts += 1;
    options.onAttempt?.(gate.attempts);
    return gate.attempts;
  };
  const claim = () => {
    if (gate.claimed || options.signal.aborted) return false;
    gate.claimed = true;
    stopAll.abort();
    return true;
  };
  const noteRunning = (update: GrabStatusUpdate) => {
    if (options.signal.aborted || gate.claimed) return;
    options.onStatus?.(update);
  };

  const worker = async () => {
    while (!options.signal.aborted && !gate.claimed) {
      let response: Record<string, unknown>;
      if (options.signal.aborted || gate.claimed) return;
      const attempts = countAttempt();
      try {
        response = await managementApi.post<Record<string, unknown>>('/api-call', {
          method: 'POST',
          url: probe.url,
          header: probe.header,
          data: probe.data,
        }, { timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS });
      } catch (error) {
        if (options.signal.aborted || gate.claimed) return;
        noteRunning({
          phase: 'running',
          status: null,
          reason: 'request-failed',
          detail: errorText(error),
          attempts,
        });
        await sleep(intervalMs, stopAll.signal);
        continue;
      }
      if (options.signal.aborted || gate.claimed) return;

      const status = readGrabStatusCode(response);
      const decision = classifyGrabStatus(status, grabRequestHasCodexFingerprint(probe.header));
      if (decision.action === 'retry') {
        noteRunning({ phase: 'running', status, reason: 'busy', detail: '', attempts });
        await sleep(intervalMs, stopAll.signal);
        continue;
      }
      if (decision.action === 'continue') {
        noteRunning({
          phase: 'running',
          status,
          reason: 'other',
          detail: apiCallErrorMessage(response),
          attempts,
        });
        await sleep(intervalMs, stopAll.signal);
        continue;
      }
      if (!claim()) return;
      if (decision.action === 'success') {
        try {
          await enableOpenAiCompatibilityProvider({
            name: options.providerName,
            baseUrl: options.baseUrl,
            apiKey,
          });
          gate.terminal = { phase: 'succeeded', status, reason: 'success', detail: '', attempts };
        } catch (error) {
          gate.terminal = {
            phase: 'stopped',
            status,
            reason: 'enable-failed',
            detail: errorText(error),
            attempts,
          };
        }
        return;
      }
      gate.terminal = {
        phase: 'stopped',
        status,
        reason: decision.reason,
        detail: apiCallErrorMessage(response),
        attempts,
      };
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    options.signal.removeEventListener('abort', abortStopAll);
  }

  const terminal = gate.terminal;
  if (terminal?.reason === 'success' || (terminal && !options.signal.aborted)) {
    return publish(terminal);
  }
  return {
    phase: 'stopped',
    status: terminal?.status ?? null,
    reason: 'aborted',
    detail: terminal?.detail ?? '',
    attempts: gate.attempts,
  };
}

export async function runAnyRouterKeepalive(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  customHeaders?: Record<string, string>;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}): Promise<void> {
  const sleep = options.sleep ?? waitForGrabInterval;
  const random = options.random ?? Math.random;
  while (!options.signal.aborted) {
    const delay = nextKeepaliveDelayMs(random);
    await sleep(delay, options.signal);
    if (options.signal.aborted) return;
    const probe = buildAnyRouterKeepaliveProbe(
      options.baseUrl,
      options.model,
      options.apiKey,
      randomKeepaliveContent(random),
      options.customHeaders,
    );
    if (!grabRequestHasCodexFingerprint(probe.header)) return;
    try {
      await managementApi.post('/api-call', {
        method: 'POST',
        url: probe.url,
        header: probe.header,
        data: probe.data,
      }, { timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS });
    } catch {
      // A failed ping does not drop the enabled provider. The next delay tries again.
    }
  }
}
