import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import {
  ANYROUTER_GRAB_DEFAULT_INTERVAL_MS,
  ANYROUTER_GRAB_MIN_INTERVAL_MS,
  runAnyRouterGrabLoop,
  type GrabLoopResult,
  type GrabStatusUpdate,
} from '../services/anyrouterLineGrab';

type ProviderTarget = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
};

const MIN_INTERVAL_SECONDS = ANYROUTER_GRAB_MIN_INTERVAL_MS / 1000;
const DEFAULT_INTERVAL_SECONDS = ANYROUTER_GRAB_DEFAULT_INTERVAL_MS / 1000;

export function AnyRouterGrabControls({
  target,
  onEnabled,
}: {
  target: ProviderTarget;
  onEnabled: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [intervalSeconds, setIntervalSeconds] = useState(DEFAULT_INTERVAL_SECONDS);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<number | null>(null);
  const [result, setResult] = useState<GrabLoopResult | null>(null);
  const [busyNote, setBusyNote] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const applyUpdate = (update: GrabStatusUpdate) => {
    setStatus(update.status);
    setBusyNote(update.reason === 'busy');
    if (update.phase === 'running') return;
    setRunning(false);
    setResult({
      phase: update.phase === 'succeeded' ? 'succeeded' : 'stopped',
      status: update.status,
      reason: update.reason === 'busy' ? 'aborted' : update.reason,
      detail: update.detail,
    });
  };

  const start = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    setBusyNote(false);
    setStatus(null);
    void runAnyRouterGrabLoop({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      providerName: target.providerName,
      intervalMs: Math.round(intervalSeconds * 1000),
      signal: controller.signal,
      onStatus: (update) => {
        if (abortRef.current !== controller) return;
        applyUpdate(update);
        if (update.reason === 'success') void onEnabled();
      },
    }).then((finalResult) => {
      if (abortRef.current !== controller) return;
      setRunning(false);
      setStatus(finalResult.status);
      setBusyNote(false);
      if (finalResult.reason !== 'aborted') setResult(finalResult);
    });
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setBusyNote(false);
    setResult({ phase: 'stopped', status, reason: 'aborted', detail: '' });
  };

  const statusLabel = status === null ? '—' : String(status);
  const message = describeGrab(result, busyNote, t);

  return (
    <div className="provider-grab-panel">
      <label>
        <span>{t('apiAccess.grab.interval')}</span>
        <input
          type="number"
          min={MIN_INTERVAL_SECONDS}
          step={1}
          value={intervalSeconds}
          disabled={running}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            setIntervalSeconds(Number.isFinite(next) ? next : DEFAULT_INTERVAL_SECONDS);
          }}
        />
      </label>
      {running ? (
        <button type="button" className="secondary-button compact-button" onClick={stop}>
          {t('apiAccess.grab.stop')}
        </button>
      ) : (
        <button type="button" className="primary-button compact-button" onClick={start}>
          {t('apiAccess.grab.start')}
        </button>
      )}
      <span className="provider-grab-status">{t('apiAccess.grab.lastStatus', { status: statusLabel })}</span>
      {message ? <span className="provider-grab-message">{message}</span> : null}
    </div>
  );
}

function describeGrab(
  result: GrabLoopResult | null,
  busy: boolean,
  t: (key: MessageKey, variables?: MessageVariables) => string,
) {
  if (busy) return t('apiAccess.grab.busy');
  if (!result || result.reason === 'aborted') {
    return result?.reason === 'aborted' ? t('apiAccess.grab.stopped') : '';
  }
  if (result.reason === 'success') return t('apiAccess.grab.success');
  if (result.reason === 'missing-key') return t('apiAccess.grab.missingKey');
  if (result.reason === 'missing-url') return t('apiAccess.grab.missingUrl');
  if (result.reason === 'missing-fingerprint') return t('apiAccess.grab.missingFingerprint');
  if (result.reason === 'enable-failed') return t('apiAccess.grab.enableFailed', { reason: result.detail });
  if (result.reason === 'request-failed') return t('apiAccess.grab.requestFailed', { reason: result.detail });
  const status = result.status ?? '—';
  if (result.reason === 'auth') return t('apiAccess.grab.authFailed', { status, reason: result.detail });
  return t('apiAccess.grab.failed', { status, reason: result.detail });
}
