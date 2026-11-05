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

/** Plain-language texts for refusals (customers never see API internals, SPEC 3). */
export function explain(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please try again.';
  const t: Record<string, string> = {
    OWNER_FIRST: 'The shop has to approve first.',
    TERMS_CHANGED: 'The proposal changed. Please review it again.',
    OFFER_EXPIRED: 'This proposal has expired.',
    NOT_AWAITING_APPROVAL: 'This proposal is no longer waiting for approval.',
    ALREADY_DECIDED: 'You have already decided on this proposal.',
    NOT_REJECTABLE: 'The payment has started; this demo does not offer cancellation after that.',
    NOT_STARTABLE: 'The payment cannot start yet (waiting for the other approvals).',
    CASE_IN_PROGRESS: 'Your conditions are locked while a swap is in progress.',
    SWAP_DONE: 'The swap in this demo world is finished.',
    QUESTIONS_UNANSWERED: 'Please answer the questions, or change the times in the form yourself, before confirming.',
    FORM_INVALID: 'Please check the times: they must be inside business hours and in the coming weeks.',
    PAYMENT_EXPIRED: 'The payment window expired. Nothing was charged.',
    MODE_MISMATCH: 'This action is not available in this payment mode.',
    PAYMENT_MODE_UNAVAILABLE: 'The payment service for this demo world is not available on this server.',
    ALREADY_PAID: 'This booking is already paid.',
    ORDER_CREATE_UNCONFIRMED: 'PayPal did not answer yet. Please try again in a moment.',
    NO_SESSION: 'Your session has ended. Please open your invite link again.',
    CSRF: 'Please reload the page.',
    ORIGIN: 'Please open FlexSlot from its own address (http://localhost:8787).',
    TEXT_LENGTH: 'Please write between 1 and 2000 characters.',
  };
  return t[e.code] ?? 'This action is not possible right now.';
}
