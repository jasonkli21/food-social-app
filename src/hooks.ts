import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import type { Page, PageRead } from './types';
import { useApp } from './state';
import { ServiceError } from './services/client';

type Result<T> = { stamp: string; data?: T; error?: string; loading: boolean };
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export function useData<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const { revision, initialized, sessionGeneration, scopes } = useApp();
  const group = key.split(':', 1)[0] ?? key;
  const stamp = JSON.stringify([key, revision, sessionGeneration, scopes[group] ?? 0, scopes[key] ?? 0]);
  const [count, change] = useState(0);
  const [state, setState] = useState<Result<T>>({ stamp, loading: true });
  const fn = useRef(fetcher);
  fn.current = fetcher;
  const reload = useCallback(() => change(c => c + 1), []);

  useEffect(() => {
    if (!initialized || !enabled) return;
    const controller = new AbortController();
    setState(old => ({ stamp, data: old.stamp === stamp ? old.data : undefined, loading: true }));
    const fetch = fn.current;
    void Promise.resolve().then(() => fetch(controller.signal)).then(data => {
      if (!controller.signal.aborted) setState({ stamp, data, loading: false });
    }, error => {
      if (!controller.signal.aborted) {
        const unavailable = error instanceof ServiceError && [401, 403, 404].includes(error.status);
        setState(old => ({ stamp, data: unavailable ? undefined : old.data, error: errorMessage(error), loading: false }));
      }
    });
    return () => controller.abort();
  }, [stamp, initialized, enabled, count]);

  if (!enabled) return { data: undefined, error: undefined, loading: false, reload };
  if (state.stamp !== stamp) return { data: undefined, error: undefined, loading: true, reload };
  return { ...state, reload };
}

export function usePage<T extends { id: string }>(
  key: string, fetcher: (offset: number, read: PageRead) => Promise<Page<T>>, enabled = true,
) {
  const first = useData(key, signal => fetcher(0, { signal }), enabled);
  const [rest, setRest] = useState<{ root: Page<T>; items: T[]; next: Page<T> }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<{ root: Page<T>; message: string }>();
  const inFlight = useRef<AbortController | null>(null);
  const root = first.data;
  const next = rest && rest.root === root ? rest.next : root;
  const base = root?.items ?? [];
  const extra = rest?.root === root ? rest?.items ?? [] : [];
  const ids = new Set(base.map(item => item.id));
  const items = [...base, ...extra.filter(item => !ids.has(item.id))];
  const hasMore = next?.nextOffset != null || Boolean(next?.nextCursor);

  useEffect(() => () => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, [root]);

  async function more() {
    if (!root || !hasMore || first.loading || inFlight.current) return;
    const current = new AbortController();
    inFlight.current = current;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await fetcher(next?.nextOffset ?? 0, { signal: current.signal, cursor: next?.nextCursor, asOf: root.asOf });
      if (current.signal.aborted) return;
      setRest(previous => {
        const all = previous?.root === root ? previous.items : [];
        const known = new Set([...all, ...root.items].map(item => item.id));
        return { root, items: [...all, ...page.items.filter(item => !known.has(item.id))], next: page };
      });
    } catch (error) {
      if (!current.signal.aborted && root.asOf && error instanceof ServiceError && error.status === 400) {
        first.reload();
        return;
      }
      if (!current.signal.aborted) setMoreError({ root, message: errorMessage(error) });
    } finally {
      if (inFlight.current === current) inFlight.current = null;
      if (!current.signal.aborted) setLoadingMore(false);
    }
  }
  return { items, loading: first.loading, reload: first.reload, error: first.error,
    loadingMore: loadingMore && inFlight.current !== null, more, hasMore, moreError: moreError?.root === root ? moreError?.message : undefined };
}

export function useTask() {
  const { toast } = useApp();
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<number>();
  async function run<T>(action: () => Promise<T>, inline = false): Promise<T | undefined> {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    setStatus(undefined);
    try {
      return await action();
    } catch (e) {
      const message = errorMessage(e);
      if (inline) {
        setError(message);
        setStatus(e instanceof ServiceError ? e.status : undefined);
      } else toast(message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return { busy, error, status, setError, run };
}

export function useDebounced(value: string, delay = 230) {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    if (!value) {
      setDelayed('');
      return;
    }
    const timer = setTimeout(() => setDelayed(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return delayed;
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => setReduced(preference.matches);
      update();
      preference.addEventListener('change', update);
      return () => preference.removeEventListener('change', update);
    }
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return reduced;
}
