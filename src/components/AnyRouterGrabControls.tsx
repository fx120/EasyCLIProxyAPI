import { useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import {
  getGrabSession,
  patchGrabSessionConfig,
  resumeGrabSessionIfNeeded,
  startGrabSession,
  stopGrabSession,
  subscribeGrabSessions,
  subscribeGrabSuccess,
  anyRouterGrabSessionKey,
  type GrabSessionSnapshot,
  type GrabSessionTarget,
} from '../services/anyrouterGrabSession';
import {
  ANYROUTER_GRAB_DEFAULT_CONCURRENCY,
  ANYROUTER_GRAB_DEFAULT_INTERVAL_MS,
  ANYROUTER_GRAB_MAX_CONCURRENCY,
  ANYROUTER_GRAB_MIN_INTERVAL_MS,
  formatGrabElapsed,
} from '../services/anyrouterLineGrab';

type ProviderTarget = GrabSessionTarget & {
  models: string[];
};

export function AnyRouterGrabControls({
  target,
  onEnabled,
}: {
  target: ProviderTarget;
  onEnabled: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const key = anyRouterGrabSessionKey(target.providerName, target.baseUrl, target.apiKey);
  const session = useSyncExternalStore(
    subscribeGrabSessions,
    () => getGrabSession(key),
    () => getGrabSession(key),
  );
  const modelList = target.models.filter((model) => model.trim()).join('\0');
  const [missingModel, setMissingModel] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    return subscribeGrabSuccess(() => {
      void onEnabled();
    });
  }, [onEnabled]);

  useEffect(() => {
    resumeGrabSessionIfNeeded(key, {
      providerName: target.providerName,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      customHeaders: target.customHeaders,
    });
  }, [key, target.providerName, target.baseUrl, target.apiKey, target.customHeaders]);

  useEffect(() => {
    const names = modelList ? modelList.split('\0') : [];
    if (names.length === 0) return;
    const current = getGrabSession(key);
    if (current.running || current.keepalive || !current.model || names.includes(current.model)) return;
    patchGrabSessionConfig(key, { model: '' });
  }, [key, modelList]);

  useEffect(() => {
    if (!session.running || session.startedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [session.running, session.startedAt]);

  const held = session.running || session.keepalive;
  const elapsedMs = session.running && session.startedAt != null
    ? Math.max(0, now - session.startedAt)
    : session.elapsedMs;
  const statusLabel = session.status === null ? '—' : String(session.status);
  const message = describeGrab(session, missingModel, t);

  const start = () => {
    if (!session.model.trim()) {
      setMissingModel(true);
      return;
    }
    setMissingModel(false);
    startGrabSession(key, target, session.model);
  };

  return (
    <div className="provider-grab-panel">
      <label>
        <span>{t('apiAccess.grab.model')}</span>
        <select
          value={session.model}
          disabled={held}
          onChange={(event) => {
            setMissingModel(false);
            patchGrabSessionConfig(key, { model: event.currentTarget.value });
          }}
        >
          <option value="">{t('apiAccess.grab.modelPlaceholder')}</option>
          {target.models.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('apiAccess.grab.interval')}</span>
        <input
          type="number"
          min={ANYROUTER_GRAB_MIN_INTERVAL_MS}
          step={50}
          value={session.intervalMs}
          disabled={held}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            patchGrabSessionConfig(key, {
              intervalMs: Number.isFinite(next) ? next : ANYROUTER_GRAB_DEFAULT_INTERVAL_MS,
            });
          }}
        />
      </label>
      <label>
        <span>{t('apiAccess.grab.threads')}</span>
        <input
          type="number"
          min={1}
          max={ANYROUTER_GRAB_MAX_CONCURRENCY}
          step={1}
          value={session.threads}
          disabled={held}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            patchGrabSessionConfig(key, {
              threads: Number.isFinite(next) ? next : ANYROUTER_GRAB_DEFAULT_CONCURRENCY,
            });
          }}
        />
      </label>
      {held ? (
        <button type="button" className="secondary-button compact-button" onClick={() => stopGrabSession(key)}>
          {t('apiAccess.grab.stop')}
        </button>
      ) : (
        <button type="button" className="primary-button compact-button" onClick={start}>
          {t('apiAccess.grab.start')}
        </button>
      )}
      {session.active ? (
        <span className={`provider-grab-activity ${session.running ? 'running' : session.keepalive ? 'keepalive' : 'stopped'}`}>
          <span>{session.running ? t('apiAccess.grab.running') : session.keepalive ? t('apiAccess.grab.keepalive') : t('apiAccess.grab.stopped')}</span>
          <span>{t('apiAccess.grab.elapsed', { time: formatGrabElapsed(elapsedMs) })}</span>
          <span>{t('apiAccess.grab.attempts', { count: session.attempts })}</span>
        </span>
      ) : null}
      <span className="provider-grab-status">{t('apiAccess.grab.lastStatus', { status: statusLabel })}</span>
      {message ? <span className="provider-grab-message">{message}</span> : null}
    </div>
  );
}

function describeGrab(
  session: GrabSessionSnapshot,
  missingModel: boolean,
  t: (key: MessageKey, variables?: MessageVariables) => string,
) {
  if (missingModel && !session.model.trim()) return t('apiAccess.grab.missingModel');
  if (!session.active && !session.running) return '';
  if (session.running) {
    if (session.reason === 'busy') return t('apiAccess.grab.busy');
    if (session.reason === 'request-failed') return t('apiAccess.grab.requestFailed', { reason: session.detail });
    if (session.status != null && session.detail) {
      return t('apiAccess.grab.continuing', { status: session.status, reason: session.detail });
    }
    return '';
  }
  if (session.reason === 'success') return t('apiAccess.grab.success');
  if (session.reason === 'missing-key') return t('apiAccess.grab.missingKey');
  if (session.reason === 'missing-url') return t('apiAccess.grab.missingUrl');
  if (session.reason === 'missing-model') return t('apiAccess.grab.missingModel');
  if (session.reason === 'missing-fingerprint') return t('apiAccess.grab.missingFingerprint');
  if (session.reason === 'enable-failed') return t('apiAccess.grab.enableFailed', { reason: session.detail });
  if (session.reason === 'disable-failed') return t('apiAccess.grab.disableFailed', { reason: session.detail });
  if (session.reason === 'request-failed') return t('apiAccess.grab.requestFailed', { reason: session.detail });
  if (session.reason === 'auth') {
    return t('apiAccess.grab.authFailed', { status: session.status ?? '—', reason: session.detail });
  }
  if (session.reason === 'other') {
    return t('apiAccess.grab.failed', { status: session.status ?? '—', reason: session.detail });
  }
  return '';
}
