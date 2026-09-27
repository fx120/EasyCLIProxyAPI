import { describe, expect, it, spyOn } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import { CODEX_CLIENT_FINGERPRINT_HEADERS } from '../src/services/quotaService';
import {
  ANYROUTER_GRAB_MIN_INTERVAL_MS,
  anyRouterGrabEndpoint,
  anyRouterGrabHeaders,
  clampGrabIntervalMs,
  classifyGrabStatus,
  findOpenAiCompatibilityIndex,
  grabRequestHasCodexFingerprint,
  isAnyRouterBaseUrl,
  runAnyRouterGrabLoop,
} from '../src/services/anyrouterLineGrab';

const provider = {
  name: 'anyrouter_qidian8',
  'base-url': 'https://anyrouter.top/v1',
  disabled: true,
  'api-key-entries': [{ 'api-key': 'sk-test-key' }],
};

describe('AnyRouter line grab', () => {
  it('requests the configured OpenAI base through the models URL and reuses the Codex fingerprint', () => {
    expect(anyRouterGrabEndpoint('https://anyrouter.top/v1')).toBe('https://anyrouter.top/v1/models');
    expect(isAnyRouterBaseUrl('https://anyrouter.top/v1')).toBe(true);
    expect(isAnyRouterBaseUrl('https://api.example.com/v1')).toBe(false);
    const headers = anyRouterGrabHeaders('sk-test-key');
    expect(grabRequestHasCodexFingerprint(headers)).toBe(true);
    expect(headers).toMatchObject({
      ...CODEX_CLIENT_FINGERPRINT_HEADERS,
      Authorization: 'Bearer sk-test-key',
    });
    expect(headers['User-Agent']).toBe(CODEX_CLIENT_FINGERPRINT_HEADERS['User-Agent']);
    expect(headers['OpenAI-Beta']).toBe('codex-1');
    expect(headers.Originator).toBe('Codex Desktop');
    expect(headers['Chatgpt-Account-Id']).toBeUndefined();
  });

  it('keeps polling only on HTTP 500, succeeds only on 200 with the fingerprint, and stops on auth failures', () => {
    expect(classifyGrabStatus(500, true)).toEqual({ action: 'retry' });
    expect(classifyGrabStatus(200, true)).toEqual({ action: 'success' });
    expect(classifyGrabStatus(200, false)).toEqual({ action: 'stop', reason: 'missing-fingerprint' });
    expect(classifyGrabStatus(401, true)).toEqual({ action: 'stop', reason: 'auth' });
    expect(classifyGrabStatus(403, true)).toEqual({ action: 'stop', reason: 'auth' });
    expect(classifyGrabStatus(404, true)).toEqual({ action: 'stop', reason: 'other' });
    expect(classifyGrabStatus(502, true)).toEqual({ action: 'stop', reason: 'other' });
    expect(clampGrabIntervalMs(200)).toBe(ANYROUTER_GRAB_MIN_INTERVAL_MS);
    expect(clampGrabIntervalMs(Number.NaN)).toBe(2_000);
  });

  it('enables the matching OpenAI-compatible entry after 200 and does not request again', async () => {
    const post = spyOn(managementApi, 'post');
    const get = spyOn(managementApi, 'get');
    const patch = spyOn(managementApi, 'patch');
    let attempts = 0;
    post.mockImplementation(async () => {
      attempts += 1;
      return (attempts === 1
        ? { status_code: 500, body: { error: { message: 'busy' } } }
        : { status_code: 200, body: { data: [] } }) as never;
    });
    get.mockResolvedValue({ 'openai-compatibility': [provider, { name: 'other', 'base-url': 'https://example.com/v1' }] } as never);
    patch.mockResolvedValue({} as never);
    const sleeps: number[] = [];

    const result = await runAnyRouterGrabLoop({
      baseUrl: 'https://anyrouter.top/v1',
      apiKey: 'sk-test-key',
      providerName: 'anyrouter_qidian8',
      intervalMs: 250,
      signal: new AbortController().signal,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(result).toMatchObject({ phase: 'succeeded', status: 200, reason: 'success' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe('/api-call');
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      url: 'https://anyrouter.top/v1/models',
      header: anyRouterGrabHeaders('sk-test-key'),
    });
    expect(sleeps).toEqual([1_000]);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('/openai-compatibility', {
      index: 0,
      value: { disabled: false },
    });
    post.mockRestore();
    get.mockRestore();
    patch.mockRestore();
  });

  it('stops on 401 without enabling the provider', async () => {
    const post = spyOn(managementApi, 'post').mockResolvedValue({
      status_code: 401,
      body: { error: { message: '无效的令牌' } },
    } as never);
    const patch = spyOn(managementApi, 'patch');
    const result = await runAnyRouterGrabLoop({
      baseUrl: 'https://anyrouter.top/v1',
      apiKey: 'sk-test-key',
      providerName: 'anyrouter_qidian8',
      intervalMs: 1_000,
      signal: new AbortController().signal,
      sleep: async () => { throw new Error('should not wait'); },
    });
    expect(result.phase).toBe('stopped');
    expect(result.reason).toBe('auth');
    expect(result.status).toBe(401);
    expect(result.detail).toContain('无效的令牌');
    expect(patch).not.toHaveBeenCalled();
    post.mockRestore();
    patch.mockRestore();
  });

  it('does not send another request after stop during the busy wait', async () => {
    const post = spyOn(managementApi, 'post').mockResolvedValue({ status_code: 500 } as never);
    const controller = new AbortController();
    const result = await runAnyRouterGrabLoop({
      baseUrl: 'https://anyrouter.top/v1',
      apiKey: 'sk-test-key',
      providerName: 'anyrouter_qidian8',
      intervalMs: 5_000,
      signal: controller.signal,
      onStatus: (update) => {
        if (update.reason === 'busy') controller.abort();
      },
      sleep: async (_ms, signal) => {
        if (signal.aborted) return;
        throw new Error('wait should observe the abort');
      },
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('aborted');
    post.mockRestore();
  });

  it('finds the saved provider by name, base URL, and key', () => {
    expect(findOpenAiCompatibilityIndex([
      { name: 'other', 'base-url': 'https://anyrouter.top/v1', 'api-key-entries': [{ 'api-key': 'sk-other' }] },
      provider,
    ], {
      name: 'anyrouter_qidian8',
      baseUrl: 'https://anyrouter.top/v1/',
      apiKey: 'sk-test-key',
    })).toBe(1);
  });
});
