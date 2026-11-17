'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/backend/' + path, { ...init, cache: 'no-store', headers: { ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  if (!response.ok) {
    let message = 'The request could not be completed.';
    try {
      message = (await response.json()).error?.message ?? message;
    }
    catch { }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}
export function useResource<T>(path: string | null, poll = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loadedPath = useRef<string | null>(null);
  const hasData = useRef(false);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const pathChanged = loadedPath.current !== path;
    loadedPath.current = path;
    // Only clear current view when switching to a different resource or when no data is loaded yet.
    // Same-path reloads and poll interval transitions refresh silently in place without blinking.
    if (pathChanged) {
      hasData.current = false;
      setData(null);
      setLoading(true);
      setError('');
    } else if (!hasData.current) {
      setLoading(true);
      setError('');
    }
    const load = async () => {
      if (!path) {
        setLoading(false);
        return;
      }
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (!disposed) {
          hasData.current = true;
          setData(value);
          setError('');
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Request failed.');
      } finally {
        if (!disposed) {
          setLoading(false);
          if (poll)
            timer = setTimeout(() => { void load(); }, poll);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, poll, version]);
  return { data, error, loading, reload };
}
export function date(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
export function label(value: string) { return value.replaceAll('_', ' ').toLowerCase().replace(/^./, char => char.toUpperCase()); }
export function fileSize(bytes: number) { return bytes < 1048576 ? Math.ceil(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'; }
