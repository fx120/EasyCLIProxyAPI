import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ANYROUTER_GRAB_SESSION_STORAGE_KEY,
  anyRouterGrabSessionKey,
  getGrabSession,
  patchGrabSessionConfig,
  resetGrabSessionsForTests,
  resumeGrabSessionIfNeeded,
  setGrabSessionStorageForTests,
  startGrabSession,
  stopGrabSession,
  subscribeGrabSessions,
} from '../src/services/anyrouterGrabSession';
import { managementApi } from '../src/services/managementApi';

const target = {
  providerName: 'anyrouter_qidian8',
  baseUrl: 'https://anyrouter.top/v1',
  apiKey: 'sk-test-key',
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error('timed out waiting for grab session');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('AnyRouter grab session', () => {
  const storage = memoryStorage();

  afterEach(() => {
    setGrabSessionStorageForTests(null);
  });

  it('persists configuration without the API key and restores it', () => {
    setGrabSessionStorageForTests(storage);
    const key = anyRouterGrabSessionKey(target.providerName, target.baseUrl, target.apiKey);
    patchGrabSessionConfig(key, { intervalMs: 400, threads: 3, model: 'gpt-6-astra' });

    const raw = storage.getItem(ANYROUTER_GRAB_SESSION_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('sk-test-key');
    expect(JSON.parse(raw)[key]).toMatchObject({
      intervalMs: 400,
      threads: 3,
      model: 'gpt-6-astra',
      running: false,
    });

    resetGrabSessionsForTests();
    expect(getGrabSession(key)).toMatchObject({
      intervalMs: 400,
      threads: 3,
      model: 'gpt-6-astra',
      attempts: 0,
      running: false,
    });
  });

  it('keeps a running grab, its counts, and its status after listeners go away', async () => {
    setGrabSessionStorageForTests(storage);
    const post = spyOn(managementApi, 'post').mockResolvedValue({
      status_code: 404,
      body: { error: { message: '当前 API 不支持所选模型 gpt-6-astra' } },
    } as never);
    const get = spyOn(managementApi, 'get').mockResolvedValue({
      'openai-compatibility': [{
        name: target.providerName,
        'base-url': target.baseUrl,
        'api-key-entries': [{ 'api-key': target.apiKey }],
      }],
    } as never);
    const patch = spyOn(managementApi, 'patch').mockResolvedValue({} as never);
    const key = anyRouterGrabSessionKey(target.providerName, target.baseUrl, target.apiKey);
    patchGrabSessionConfig(key, { intervalMs: 50, threads: 2, model: 'gpt-6-astra' });

    expect(startGrabSession(key, target, '  ')).toBe(false);
    expect(getGrabSession(key).running).toBe(false);
    expect(startGrabSession(key, target, 'gpt-6-astra')).toBe(true);

    await waitFor(() => getGrabSession(key).attempts >= 1 && getGrabSession(key).status === 404);
    const startedAt = getGrabSession(key).startedAt;
    const unsubscribe = subscribeGrabSessions(() => {});
    unsubscribe();
    const seen = getGrabSession(key).attempts;

    await waitFor(() => getGrabSession(key).attempts > seen);
    expect(getGrabSession(key).running).toBe(true);
    expect(getGrabSession(key).startedAt).toBe(startedAt);
    expect(getGrabSession(key).detail).toContain('gpt-6-astra');

    resumeGrabSessionIfNeeded(key, target);
    expect(getGrabSession(key).startedAt).toBe(startedAt);
    expect(getGrabSession(key).running).toBe(true);

    const attempts = getGrabSession(key).attempts;
    stopGrabSession(key);
    expect(getGrabSession(key)).toMatchObject({
      running: false,
      active: true,
      status: 404,
      model: 'gpt-6-astra',
      intervalMs: 50,
      threads: 2,
    });
    expect(getGrabSession(key).attempts).toBeGreaterThanOrEqual(attempts);
    expect(getGrabSession(key).elapsedMs).toBeGreaterThanOrEqual(0);
    expect(getGrabSession(key).startedAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getGrabSession(key).running).toBe(false);
    expect(getGrabSession(key).attempts).toBeGreaterThanOrEqual(attempts);
    expect(storage.getItem(ANYROUTER_GRAB_SESSION_STORAGE_KEY) ?? '').not.toContain('sk-test-key');
    post.mockRestore();
    get.mockRestore();
    patch.mockRestore();
  });

  it('restores a running session and continues the same attempt count', async () => {
    setGrabSessionStorageForTests(storage);
    const key = anyRouterGrabSessionKey(target.providerName, target.baseUrl, target.apiKey);
    const startedAt = Date.now() - 12_000;
    storage.setItem(ANYROUTER_GRAB_SESSION_STORAGE_KEY, JSON.stringify({
      [key]: {
        intervalMs: 50,
        threads: 1,
        model: 'gpt-6-astra',
        running: true,
        startedAt,
        elapsedMs: 12_000,
        attempts: 7,
        status: 404,
        reason: 'other',
        detail: '当前 API 不支持所选模型 gpt-6-astra',
        active: true,
      },
    }));
    resetGrabSessionsForTests();
    expect(getGrabSession(key)).toMatchObject({
      running: true,
      attempts: 7,
      startedAt,
      status: 404,
      model: 'gpt-6-astra',
    });

    const post = spyOn(managementApi, 'post').mockResolvedValue({
      status_code: 500,
      body: { error: { message: 'busy' } },
    } as never);
    const get = spyOn(managementApi, 'get').mockResolvedValue({
      'openai-compatibility': [{
        name: target.providerName,
        'base-url': target.baseUrl,
        'api-key-entries': [{ 'api-key': target.apiKey }],
      }],
    } as never);
    const patch = spyOn(managementApi, 'patch').mockResolvedValue({} as never);
    resumeGrabSessionIfNeeded(key, target);
    await waitFor(() => getGrabSession(key).attempts > 7 && getGrabSession(key).status === 500);
    expect(getGrabSession(key).startedAt).toBe(startedAt);
    expect(getGrabSession(key).running).toBe(true);
    expect(post.mock.calls.length).toBeGreaterThan(0);

    stopGrabSession(key);
    post.mockRestore();
    get.mockRestore();
    patch.mockRestore();
  });
});
