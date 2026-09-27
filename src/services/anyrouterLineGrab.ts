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

export const ANYROUTER_GRAB_MIN_INTERVAL_MS = 1_000;
export const ANYROUTER_GRAB_DEFAULT_INTERVAL_MS = 2_000;

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
  | { action: 'success' }
  | { action: 'stop'; reason: 'auth' | 'other' | 'missing-fingerprint' };

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
  | 'aborted';

export type GrabStatusUpdate = {
  phase: 'running' | 'succeeded' | 'stopped';
  status: number | null;
  reason: GrabStopReason | 'busy';
  detail: string;
};

export type GrabLoopResult = {
  phase: 'succeeded' | 'stopped';
  status: number | null;
  reason: GrabStopReason;
  detail: string;
};

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

/** First model name from the same list 健康检测 starts with. */
export function anyRouterGrabModel(models: ModelOption[]): string {
  return mergeProviderHealthModels([], models)[0]?.name.trim() ?? '';
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
  return buildProviderHealthProbe('openai', baseUrl, model, apiKey, '', {
    ...customHeaders,
    ...codexClientFingerprintHeaders(),
  });
}

export function clampGrabIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return ANYROUTER_GRAB_DEFAULT_INTERVAL_MS;
  return Math.max(ANYROUTER_GRAB_MIN_INTERVAL_MS, Math.round(value));
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
  return { action: 'stop', reason: 'other' };
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

export async function enableOpenAiCompatibilityProvider(match: OpenAiProviderMatch): Promise<void> {
  const payload = await managementApi.get('/openai-compatibility');
  const records = responseList(payload, 'openai-compatibility');
  const index = findOpenAiCompatibilityIndex(records, match);
  if (index < 0) throw new Error('OpenAI compatibility entry no longer exists');
  await managementApi.patch('/openai-compatibility', {
    index,
    value: { disabled: false },
  });
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
  signal: AbortSignal;
  onStatus?: (update: GrabStatusUpdate) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<GrabLoopResult> {
  const sleep = options.sleep ?? waitForGrabInterval;
  const finish = (result: GrabLoopResult): GrabLoopResult => {
    if (options.signal.aborted && result.reason !== 'success') {
      return { phase: 'stopped', status: result.status, reason: 'aborted', detail: '' };
    }
    options.onStatus?.({
      phase: result.phase === 'succeeded' ? 'succeeded' : 'stopped',
      status: result.status,
      reason: result.reason,
      detail: result.detail,
    });
    return result;
  };

  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    return finish({ phase: 'stopped', status: null, reason: 'missing-key', detail: '' });
  }
  if (!options.baseUrl.trim()) {
    return finish({ phase: 'stopped', status: null, reason: 'missing-url', detail: '' });
  }

  let probe;
  try {
    probe = buildAnyRouterGrabProbe(options.baseUrl, options.model, apiKey, options.customHeaders);
  } catch (error) {
    const message = errorText(error);
    if (message === 'missing model') {
      return finish({ phase: 'stopped', status: null, reason: 'missing-model', detail: '' });
    }
    return finish({
      phase: 'stopped',
      status: null,
      reason: 'missing-url',
      detail: message === 'missing base url' ? '' : message,
    });
  }
  if (!probe.url) {
    return finish({ phase: 'stopped', status: null, reason: 'missing-url', detail: '' });
  }
  if (!grabRequestHasCodexFingerprint(probe.header)) {
    return finish({ phase: 'stopped', status: null, reason: 'missing-fingerprint', detail: '' });
  }

  const intervalMs = clampGrabIntervalMs(options.intervalMs);
  while (!options.signal.aborted) {
    let response: Record<string, unknown>;
    try {
      response = await managementApi.post<Record<string, unknown>>('/api-call', {
        method: 'POST',
        url: probe.url,
        header: probe.header,
        data: probe.data,
      }, { timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS });
    } catch (error) {
      if (options.signal.aborted) {
        return { phase: 'stopped', status: null, reason: 'aborted', detail: '' };
      }
      return finish({
        phase: 'stopped',
        status: null,
        reason: 'request-failed',
        detail: errorText(error),
      });
    }
    if (options.signal.aborted) {
      return { phase: 'stopped', status: readGrabStatusCode(response), reason: 'aborted', detail: '' };
    }

    const status = readGrabStatusCode(response);
    const decision = classifyGrabStatus(status, grabRequestHasCodexFingerprint(probe.header));
    if (decision.action === 'retry') {
      options.onStatus?.({ phase: 'running', status, reason: 'busy', detail: '' });
      await sleep(intervalMs, options.signal);
      continue;
    }
    if (decision.action === 'success') {
      try {
        await enableOpenAiCompatibilityProvider({
          name: options.providerName,
          baseUrl: options.baseUrl,
          apiKey,
        });
      } catch (error) {
        return finish({
          phase: 'stopped',
          status,
          reason: 'enable-failed',
          detail: errorText(error),
        });
      }
      return finish({ phase: 'succeeded', status, reason: 'success', detail: '' });
    }
    return finish({
      phase: 'stopped',
      status,
      reason: decision.reason,
      detail: apiCallErrorMessage(response),
    });
  }
  return { phase: 'stopped', status: null, reason: 'aborted', detail: '' };
}
