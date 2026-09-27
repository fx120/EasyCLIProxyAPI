import { describe, expect, it, spyOn } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import { buildProviderHealthProbe } from '../src/services/providerHealthCheck';
import { CODEX_CLIENT_FINGERPRINT_HEADERS, codexClientFingerprintHeaders } from '../src/services/quotaService';
import {
  ANYROUTER_GRAB_MAX_CONCURRENCY,
  ANYROUTER_GRAB_MIN_INTERVAL_MS,
  anyRouterGrabHeaders,
  anyRouterGrabModels,
  buildAnyRouterGrabProbe,
  clampGrabConcurrency,
  clampGrabIntervalMs,
  classifyGrabStatus,
  findOpenAiCompatibilityIndex,
  formatGrabElapsed,
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

const grabTarget = {
  baseUrl: 'https://anyrouter.top/v1',
  apiKey: 'sk-test-key',
  providerName: 'anyrouter_qidian8',
  model: 'claude-sonnet-4-20250514',
};

describe('AnyRouter line grab', () => {
  it('uses the health-check chat completions probe and the Codex fingerprint', () => {
    expect(isAnyRouterBaseUrl('https://anyrouter.top/v1')).toBe(true);
    expect(isAnyRouterBaseUrl('https://api.example.com/v1')).toBe(false);
    expect(anyRouterGrabModels([
      { name: 'gpt-5-codex' },
      { name: 'claude-sonnet-4-20250514' },
      { name: 'gemini-2.5-pro' },
    ])).toEqual([
      'claude-sonnet-4-20250514',
      'gemini-2.5-pro',
      'gpt-5-codex',
    ]);
    const probe = buildAnyRouterGrabProbe(
      'https://anyrouter.top/v1',
      'claude-sonnet-4-20250514',
      'sk-test-key',
    );
    expect(probe).toEqual(buildProviderHealthProbe(
      'openai',
      'https://anyrouter.top/v1',
      'claude-sonnet-4-20250514',
      'sk-test-key',
      '',
      codexClientFingerprintHeaders(),
    ));
    expect(probe.url).toBe('https://anyrouter.top/v1/chat/completions');
    expect(probe.protocol).toBe('openai-chat');
    expect(JSON.parse(probe.data)).toEqual({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(grabRequestHasCodexFingerprint(probe.header)).toBe(true);
    expect(probe.header).toMatchObject({
      ...CODEX_CLIENT_FINGERPRINT_HEADERS,
      Authorization: 'Bearer sk-test-key',
    });
    expect(probe.header['Chatgpt-Account-Id']).toBeUndefined();
    expect(anyRouterGrabHeaders('sk-test-key').Authorization).toBe('Bearer sk-test-key');
  });

  it('keeps polling on HTTP 500 and other non-auth failures, succeeds only on 200, and stops on auth failures', () => {
    expect(classifyGrabStatus(500, true)).toEqual({ action: 'retry' });
    expect(classifyGrabStatus(200, true)).toEqual({ action: 'success' });
    expect(classifyGrabStatus(200, false)).toEqual({ action: 'stop', reason: 'missing-fingerprint' });
    expect(classifyGrabStatus(401, true)).toEqual({ action: 'stop', reason: 'auth' });
    expect(classifyGrabStatus(403, true)).toEqual({ action: 'stop', reason: 'auth' });
    expect(classifyGrabStatus(404, true)).toEqual({ action: 'continue' });
    expect(classifyGrabStatus(502, true)).toEqual({ action: 'continue' });
    expect(clampGrabIntervalMs(10)).toBe(ANYROUTER_GRAB_MIN_INTERVAL_MS);
    expect(clampGrabIntervalMs(200)).toBe(200);
    expect(clampGrabIntervalMs(Number.NaN)).toBe(2_000);
    expect(clampGrabConcurrency(0)).toBe(1);
    expect(clampGrabConcurrency(4.2)).toBe(4);
    expect(clampGrabConcurrency(100)).toBe(ANYROUTER_GRAB_MAX_CONCURRENCY);
    expect(clampGrabConcurrency(Number.NaN)).toBe(1);
    expect(formatGrabElapsed(0)).toBe('0:00');
    expect(formatGrabElapsed(1_500)).toBe('0:01');
    expect(formatGrabElapsed(65_000)).toBe('1:05');
    expect(formatGrabElapsed(3_661_000)).toBe('1:01:01');
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
      ...grabTarget,
      intervalMs: 250,
      signal: new AbortController().signal,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const probe = buildAnyRouterGrabProbe(grabTarget.baseUrl, grabTarget.model, grabTarget.apiKey);
    expect(result).toMatchObject({ phase: 'succeeded', status: 200, reason: 'success', attempts: 2 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe('/api-call');
    expect(post.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      url: 'https://anyrouter.top/v1/chat/completions',
      header: probe.header,
      data: probe.data,
    });
    expect(post.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      url: 'https://anyrouter.top/v1/chat/completions',
    });
    expect(sleeps).toEqual([250]);
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
      ...grabTarget,
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

  it('keeps grabbing after 404 until another probe returns 200', async () => {
    const post = spyOn(managementApi, 'post');
    const get = spyOn(managementApi, 'get');
    const patch = spyOn(managementApi, 'patch');
    const queue = [404, 200];
    post.mockImplementation(async () => {
      const status = queue.shift() ?? 500;
      return {
        status_code: status,
        body: status === 404 ? { error: { message: '当前 API 不支持所选模型' } } : {},
      } as never;
    });
    get.mockResolvedValue({ 'openai-compatibility': [provider] } as never);
    patch.mockResolvedValue({} as never);
    const notices: string[] = [];

    const result = await runAnyRouterGrabLoop({
      ...grabTarget,
      concurrency: 2,
      intervalMs: 50,
      signal: new AbortController().signal,
      onStatus: (update) => {
        if (update.reason === 'other') notices.push(update.detail);
      },
      sleep: async (_ms, signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    expect(result).toMatchObject({ phase: 'succeeded', status: 200, reason: 'success' });
    expect(notices.some((detail) => detail.includes('当前 API 不支持所选模型'))).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(1);
    post.mockRestore();
    get.mockRestore();
    patch.mockRestore();
  });

  it('stops every thread on 401 and enables the provider only once when two probes return 200', async () => {
    const post = spyOn(managementApi, 'post');
    const get = spyOn(managementApi, 'get');
    const patch = spyOn(managementApi, 'patch');
    get.mockResolvedValue({ 'openai-compatibility': [provider] } as never);
    patch.mockResolvedValue({} as never);

    const authQueue = [500, 401];
    post.mockImplementation(async () => {
      const status = authQueue.shift() ?? 500;
      return { status_code: status, body: { error: { message: '无效的令牌' } } } as never;
    });
    const authResult = await runAnyRouterGrabLoop({
      ...grabTarget,
      concurrency: 2,
      intervalMs: 50,
      signal: new AbortController().signal,
      sleep: async (_ms, signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    expect(authResult).toMatchObject({ phase: 'stopped', reason: 'auth', status: 401 });
    expect(authResult.detail).toContain('无效的令牌');
    expect(patch).not.toHaveBeenCalled();

    post.mockResolvedValue({ status_code: 200, body: {} } as never);
    const success = await runAnyRouterGrabLoop({
      ...grabTarget,
      concurrency: 2,
      intervalMs: 50,
      signal: new AbortController().signal,
      sleep: async () => { throw new Error('should not wait'); },
    });
    expect(success).toMatchObject({ phase: 'succeeded', status: 200, reason: 'success' });
    expect(patch).toHaveBeenCalledTimes(1);

    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opened = new Promise<void>((resolve) => {
      post.mockImplementation(async () => {
        started += 1;
        if (started === ANYROUTER_GRAB_MAX_CONCURRENCY) resolve();
        await gate;
        return { status_code: 401, body: { error: { message: '无效的令牌' } } } as never;
      });
    });
    const capped = runAnyRouterGrabLoop({
      ...grabTarget,
      concurrency: 100,
      intervalMs: 50,
      signal: new AbortController().signal,
      sleep: async () => { throw new Error('should not wait'); },
    });
    await opened;
    expect(started).toBe(ANYROUTER_GRAB_MAX_CONCURRENCY);
    release();
    await expect(capped).resolves.toMatchObject({ reason: 'auth', status: 401 });
    expect(patch).toHaveBeenCalledTimes(1);

    post.mockRestore();
    get.mockRestore();
    patch.mockRestore();
  });

  it('counts one attempt for every in-flight probe across threads', async () => {
    const post = spyOn(managementApi, 'post');
    const get = spyOn(managementApi, 'get');
    const patch = spyOn(managementApi, 'patch');
    get.mockResolvedValue({ 'openai-compatibility': [provider] } as never);
    patch.mockResolvedValue({} as never);
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opened = new Promise<void>((resolve) => {
      post.mockImplementation(async () => {
        started += 1;
        if (started === 3) resolve();
        await gate;
        return { status_code: 404, body: { error: { message: '当前 API 不支持所选模型' } } } as never;
      });
    });
    const seen: number[] = [];
    const controller = new AbortController();
    const pending = runAnyRouterGrabLoop({
      ...grabTarget,
      concurrency: 3,
      intervalMs: 50,
      signal: controller.signal,
      onAttempt: (attempts) => { seen.push(attempts); },
      sleep: async (_ms, signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    await opened;
    expect(started).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    release();
    controller.abort();
    const result = await pending;
    expect(result.attempts).toBe(3);
    expect(patch).not.toHaveBeenCalled();
    post.mockRestore();
    get.mockRestore();
    patch.mockRestore();
  });

  it('does not request when the provider has no health-check model', async () => {
    const post = spyOn(managementApi, 'post');
    const result = await runAnyRouterGrabLoop({
      ...grabTarget,
      model: '  ',
      intervalMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ phase: 'stopped', reason: 'missing-model', status: null });
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });

  it('does not send another request after stop during the busy wait', async () => {
    const post = spyOn(managementApi, 'post').mockResolvedValue({ status_code: 500 } as never);
    const controller = new AbortController();
    const result = await runAnyRouterGrabLoop({
      ...grabTarget,
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
