// Browser side of the session (DESIGN 5): the invite token travels in the URL fragment (never sent to the server
// by the browser), is removed from the address bar with history.replaceState before anything else, and is
// exchanged by POST for an HttpOnly cookie. The CSRF token lives in memory only; a reload or a new tab asks for a
// fresh one. The browser never sends amounts or PayPal ids: only case ids and the terms version it displayed.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: string[];
  constructor(status: number, code: string, issues: string[] = []) {
    super(code);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export class Api {
  readonly base: string;
  #csrf: string | null = null;

  constructor(worldId: string, roleSeg: string) {
    this.base = `/w/${worldId}/${roleSeg}/api`;
  }

  async #fetch(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' && this.#csrf ? { 'x-csrf-token': this.#csrf } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  }

  /** Exchanges the fragment token (if any) for a session, or refreshes the CSRF token of an existing session. */
  async boot(): Promise<'ok' | 'no-session'> {
    const m = /^#t=([A-Za-z0-9_-]{20,100})$/.exec(window.location.hash);
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    const res = m ? await this.#fetch('POST', 'session', { token: m[1] }) : await this.#fetch('POST', 'session/csrf');
    if (res.status === 401) return 'no-session';
    if (!res.ok) throw new ApiError(res.status, 'SESSION');
    this.#csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    return 'ok';
  }

  async #read<T>(res: Response): Promise<T> {
    const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'ERROR', data.issues ?? []);
    return data as T;
  }

  async get<T>(path: string): Promise<T> {
    return this.#read<T>(await this.#fetch('GET', path));
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    let res = await this.#fetch('POST', path, body);
    if (res.status === 403) {
      // Another tab of the same role may have rotated the CSRF token: refresh once and retry.
      const again = await this.#fetch('POST', 'session/csrf');
      if (again.ok) {
        this.#csrf = ((await again.json()) as { csrfToken: string }).csrfToken;
        res = await this.#fetch('POST', path, body);
      }
    }
    return this.#read<T>(res);
  }
}

/** Plain-language texts for refusals (customers never see API internals, SPEC 3), in the screen's language. */
export function explain(e: unknown, t: { errors: Record<string, string>; errorDefault: string; errorUnknown: string }): string {
  if (!(e instanceof ApiError)) return t.errorUnknown;
  return t.errors[e.code] ?? t.errorDefault;
}
