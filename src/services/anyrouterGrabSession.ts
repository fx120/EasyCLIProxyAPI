import {
  ANYROUTER_GRAB_DEFAULT_CONCURRENCY,
  ANYROUTER_GRAB_DEFAULT_INTERVAL_MS,
  clampGrabConcurrency,
  clampGrabIntervalMs,
  runAnyRouterGrabLoop,
  runAnyRouterKeepalive,
  type GrabStopReason,
} from './anyrouterLineGrab';
import { normalizeBaseUrl } from './modelService';

export const ANYROUTER_GRAB_SESSION_STORAGE_KEY = 'cpa-gui.anyrouter-grab-sessions.v1';

export type GrabSessionReason = GrabStopReason | 'busy' | '';

export type GrabSessionSnapshot = {
  intervalMs: number;
  threads: number;
  model: string;
  running: boolean;
  startedAt: number | null;
  elapsedMs: number;
  attempts: number;
  status: number | null;
  reason: GrabSessionReason;
  detail: string;
  active: boolean;
  keepalive: boolean;
};

export type GrabSessionTarget = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  customHeaders?: Record<string, string>;
};

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

const EMPTY_SESSION: GrabSessionSnapshot = {
  intervalMs: ANYROUTER_GRAB_DEFAULT_INTERVAL_MS,
  threads: ANYROUTER_GRAB_DEFAULT_CONCURRENCY,
  model: '',
  running: false,
  startedAt: null,
  elapsedMs: 0,
  attempts: 0,
  status: null,
  reason: '',
  detail: '',
  active: false,
  keepalive: false,
};

const sessions = new Map<string, GrabSessionSnapshot>();
const controllers = new Map<string, AbortController>();
const keepaliveControllers = new Map<string, AbortController>();
const launchTokens = new Map<string, object>();
const listeners = new Set<() => void>();
const successListeners = new Set<() => void>();
type KeepaliveRuntime = {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
};
let keepaliveRuntime: KeepaliveRuntime | null = null;
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let storageOverride: StorageLike | null = null;

const browserStorage = (): StorageLike | null => {
  if (storageOverride) return storageOverride;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
};

export function anyRouterGrabSessionKey(providerName: string, baseUrl: string, apiKey: string): string {
  let normalized = baseUrl.trim();
  try {
    normalized = normalized ? normalizeBaseUrl(normalized) : '';
  } catch {
    normalized = baseUrl.trim();
  }
  const material = `${providerName.trim()}\0${normalized}\0${apiKey.trim()}`;
  let hash = 2166136261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function readStored(): Record<string, GrabSessionSnapshot> {
  const storage = browserStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(ANYROUTER_GRAB_SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: Record<string, GrabSessionSnapshot> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
      const session = sanitizeSession(value);
      if (session) next[key] = session;
    });
    return next;
  } catch {
    return {};
  }
}

function sanitizeSession(value: unknown): GrabSessionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<GrabSessionSnapshot>;
  const intervalMs = clampGrabIntervalMs(Number(record.intervalMs));
  const threads = clampGrabConcurrency(Number(record.threads));
  return {
    intervalMs,
    threads,
    model: typeof record.model === 'string' ? record.model : '',
    running: record.running === true,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
    elapsedMs: Number.isFinite(Number(record.elapsedMs)) ? Math.max(0, Number(record.elapsedMs)) : 0,
    attempts: Number.isFinite(Number(record.attempts)) ? Math.max(0, Math.round(Number(record.attempts))) : 0,
    status: typeof record.status === 'number' ? record.status : null,
    reason: typeof record.reason === 'string' ? record.reason as GrabSessionReason : '',
    detail: typeof record.detail === 'string' ? record.detail : '',
    active: record.active === true || record.running === true || record.keepalive === true || Number(record.attempts) > 0,
    keepalive: record.keepalive === true,
  };
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  Object.entries(readStored()).forEach(([key, session]) => {
    sessions.set(key, session);
  });
}

function writeStored() {
  const storage = browserStorage();
  if (!storage) return;
  const payload: Record<string, GrabSessionSnapshot> = {};
  sessions.forEach((session, key) => {
    if (!session.active && !session.model && session.intervalMs === EMPTY_SESSION.intervalMs && session.threads === EMPTY_SESSION.threads) {
      return;
    }
    payload[key] = session;
  });
  try {
    storage.setItem(ANYROUTER_GRAB_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // The in-memory session still keeps the grab alive if storage is full.
  }
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeStored();
  }, 200);
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeStored();
}

function emit() {
  listeners.forEach((listener) => listener());
}

function replaceSession(key: string, session: GrabSessionSnapshot, immediate = false) {
  sessions.set(key, session);
  if (immediate) persistNow();
  else persistSoon();
  emit();
}

export function subscribeGrabSessions(listener: () => void) {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeGrabSuccess(listener: () => void) {
  successListeners.add(listener);
  return () => {
    successListeners.delete(listener);
  };
}

export function getGrabSession(key: string): GrabSessionSnapshot {
  hydrate();
  return sessions.get(key) ?? EMPTY_SESSION;
}

export function patchGrabSessionConfig(
  key: string,
  patch: Partial<Pick<GrabSessionSnapshot, 'intervalMs' | 'threads' | 'model'>>,
) {
  const current = getGrabSession(key);
  if (current.running || current.keepalive) return;
  replaceSession(key, {
    ...current,
    ...patch,
    intervalMs: patch.intervalMs === undefined ? current.intervalMs : clampGrabIntervalMs(patch.intervalMs),
    threads: patch.threads === undefined ? current.threads : clampGrabConcurrency(patch.threads),
  }, true);
}

function freezeElapsed(session: GrabSessionSnapshot, now = Date.now()): number {
  if (session.startedAt == null) return session.elapsedMs;
  return Math.max(0, now - session.startedAt);
}

function notifyProviderChanged() {
  successListeners.forEach((listener) => listener());
}

function startKeepalive(key: string, target: GrabSessionTarget, model: string) {
  if (!model.trim() || keepaliveControllers.has(key)) return;
  const controller = new AbortController();
  keepaliveControllers.set(key, controller);
  void runAnyRouterKeepalive({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model,
    customHeaders: target.customHeaders,
    signal: controller.signal,
    sleep: keepaliveRuntime?.sleep,
    random: keepaliveRuntime?.random,
  }).finally(() => {
    if (keepaliveControllers.get(key) === controller) keepaliveControllers.delete(key);
  });
}

function launch(key: string, target: GrabSessionTarget, session: GrabSessionSnapshot, resetCounters: boolean) {
  const token = {};
  launchTokens.set(key, token);
  controllers.get(key)?.abort();
  keepaliveControllers.get(key)?.abort();
  keepaliveControllers.delete(key);
  const baseAttempts = resetCounters ? 0 : session.attempts;
  const startedAt = resetCounters || session.startedAt == null
    ? Date.now() - (resetCounters ? 0 : session.elapsedMs)
    : session.startedAt;
  const next: GrabSessionSnapshot = {
    ...session,
    model: session.model,
    running: true,
    startedAt,
    elapsedMs: resetCounters ? 0 : session.elapsedMs,
    attempts: baseAttempts,
    status: resetCounters ? null : session.status,
    reason: resetCounters ? '' : session.reason,
    detail: resetCounters ? '' : session.detail,
    active: true,
    keepalive: false,
  };
  const controller = new AbortController();
  controllers.set(key, controller);
  replaceSession(key, next, true);
  void runAnyRouterGrabLoop({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    providerName: target.providerName,
    model: next.model,
    customHeaders: target.customHeaders,
    intervalMs: next.intervalMs,
    concurrency: next.threads,
    signal: controller.signal,
    onAttempt: (attempts) => {
      const current = sessions.get(key);
      if (!current || controllers.get(key) !== controller) return;
      replaceSession(key, { ...current, attempts: baseAttempts + attempts });
    },
    onStatus: (update) => {
      if (update.phase !== 'running') return;
      const current = sessions.get(key);
      if (!current || controllers.get(key) !== controller) return;
      replaceSession(key, {
        ...current,
        status: update.status,
        reason: update.reason,
        detail: update.detail,
        attempts: Math.max(current.attempts, baseAttempts + update.attempts),
      });
    },
    onDisabled: () => {
      if (launchTokens.get(key) !== token || controllers.get(key) !== controller) return;
      notifyProviderChanged();
    },
  }).then((result) => {
    if (launchTokens.get(key) !== token || controllers.get(key) !== controller) return;
    controllers.delete(key);
    const current = sessions.get(key) ?? next;
    const kept = result.reason === 'success';
    const stopped: GrabSessionSnapshot = {
      ...current,
      running: false,
      startedAt: null,
      elapsedMs: freezeElapsed(current),
      attempts: Math.max(current.attempts, baseAttempts + result.attempts),
      status: result.status ?? current.status,
      reason: result.reason === 'aborted'
        ? (current.reason === 'busy' ? '' : current.reason)
        : result.reason,
      detail: result.detail || current.detail,
      active: true,
      keepalive: kept,
    };
    replaceSession(key, stopped, true);
    if (!kept || launchTokens.get(key) !== token) return;
    notifyProviderChanged();
    startKeepalive(key, target, stopped.model);
  });
}

export function startGrabSession(key: string, target: GrabSessionTarget, model: string) {
  const current = getGrabSession(key);
  const selected = model.trim();
  if (!selected) return false;
  if (current.running && controllers.has(key)) return true;
  launch(key, target, { ...current, model: selected }, true);
  return true;
}

export function resumeGrabSessionIfNeeded(key: string, target: GrabSessionTarget) {
  const current = getGrabSession(key);
  if (current.running && current.model.trim() && !controllers.has(key)) {
    launch(key, target, current, false);
    return;
  }
  if (current.keepalive && current.model.trim() && !keepaliveControllers.has(key)) {
    if (!launchTokens.has(key)) launchTokens.set(key, {});
    startKeepalive(key, target, current.model);
  }
}

export function stopGrabSession(key: string) {
  const current = getGrabSession(key);
  if (!current.active && !controllers.has(key) && !keepaliveControllers.has(key)) return;
  launchTokens.delete(key);
  controllers.get(key)?.abort();
  controllers.delete(key);
  keepaliveControllers.get(key)?.abort();
  keepaliveControllers.delete(key);
  replaceSession(key, {
    ...current,
    running: false,
    keepalive: false,
    startedAt: null,
    elapsedMs: freezeElapsed(current),
    active: true,
    reason: current.reason === 'busy' ? '' : current.reason,
  }, true);
}

export function resetGrabSessionsForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  controllers.forEach((controller) => controller.abort());
  controllers.clear();
  keepaliveControllers.forEach((controller) => controller.abort());
  keepaliveControllers.clear();
  launchTokens.clear();
  sessions.clear();
  hydrated = false;
  hydrate();
}

export function setGrabSessionStorageForTests(storage: StorageLike | null) {
  storageOverride = storage;
  resetGrabSessionsForTests();
}

export function setGrabKeepaliveRuntimeForTests(runtime: KeepaliveRuntime | null) {
  keepaliveRuntime = runtime;
}
