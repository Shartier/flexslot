// Shared pieces of the three screens: the mode bar (DESIGN 10), status chips, the PayPal approval box, and the
// intake panel (free text -> AI proposal or manual form -> the person's confirmation, DESIGN 9).

import { useEffect, useState, type ReactNode } from 'react';
import { explain, type Api } from './api.ts';
import type { Approval, CaseView, Conditions, Draft, Header, Step, Window } from './types.ts';

export function TopBar({ header, roleName }: { header: Header; roleName: string }) {
  const m = header.modes;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">FlexSlot</span>
        <span className="role">{roleName}</span>
      </div>
      <div className="modes" aria-label="Modes of this demo world">
        <span className={`mode ${m.ai === 'VERTEX' ? 'live' : 'mock'}`}>
          AI: {m.ai === 'VERTEX' ? `Gemini on Vertex AI (${m.aiModel ?? 'not configured'})` : 'mock rules (not a real AI)'}
        </span>
        <span className={`mode ${m.payment === 'SANDBOX' ? 'live' : 'mock'}`}>
          Payment: {m.payment === 'SANDBOX' ? 'PayPal Sandbox (test money)' : 'mock (no PayPal)'}
        </span>
      </div>
    </header>
  );
}

export function DemoNote({ header }: { header: Header }) {
  return (
    <p className="demo-note">
      {header.shop.name} · stylist {header.shop.stylists.join(', ')} · open {header.shop.hours} ({header.shop.timeZone}) · now {header.serverTime}. Demo world: whoever created it holds all
      three invite links; in real use each person receives only their own link.
    </p>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const STATE_CLASS: Record<string, string> = { DONE: 'ok', WAITING_BUYER: 'wait', WORKING: 'work', ATTENTION: 'bad', CANCELLED: 'muted', NONE: 'muted', UNPAID: 'wait', PAID: 'ok' };

export function StepChip({ step }: { step: Step }) {
  return <span className={`chip ${STATE_CLASS[step.state] ?? 'muted'}`}>{step.text}</span>;
}

export function StatusChip({ c }: { c: CaseView }) {
  const cls = c.status === 'COMPLETED' ? 'ok' : ['REJECTED', 'EXPIRED', 'COMPENSATED'].includes(c.status) ? 'muted' : /FAILED|ATTENTION/.test(c.status) ? 'bad' : c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED' ? 'wait' : 'work';
  return <span className={`chip ${cls}`}>{c.statusLabel}</span>;
}

export function ApprovalChips({ c }: { c: CaseView }) {
  const one = (label: string, v: string | null) => (
    <span className={`chip ${v === 'APPROVED' ? 'ok' : v === 'REJECTED' ? 'bad' : 'muted'}`}>
      {label}: {v === 'APPROVED' ? 'approved' : v === 'REJECTED' ? 'declined' : 'waiting'}
    </span>
  );
  return (
    <div className="chips">
      {one('Shop', c.approvals.OWNER)}
      {one('Existing customer', c.approvals.A)}
      {one('New customer', c.approvals.B)}
    </div>
  );
}

export function Events({ c }: { c: CaseView }) {
  if (!c.events.length) return null;
  return (
    <details className="events">
      <summary>Timeline</summary>
      <ul>
        {c.events.map((e, i) => (
          <li key={i}>
            <span className="muted-text">{e.at}</span> {e.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Notice({ kind, children }: { kind: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

/** Runs an action with a busy flag and a plain-language error. */
export function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  return { busy, error, run, setError };
}

/**
 * The PayPal step: in Sandbox mode the approval link (to open, or to copy) and "I approved"; the return page
 * also signals this tab. In mock mode a clearly labelled mock approval button.
 */
export function ApprovalBox(p: { approval: Approval | null; onApproved: () => Promise<void>; onMock: () => Promise<void>; busy: boolean; who: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;
    const ch = new BroadcastChannel('flexslot-paypal');
    ch.onmessage = (ev: MessageEvent<{ type?: string }>) => {
      if (ev.data?.type === 'approved') void p.onApproved();
    };
    return () => ch.close();
  }, [p.onApproved]);
  if (!p.approval) return null;
  if (p.approval.kind === 'MOCK') {
    return (
      <div className="paybox mockpay">
        <p>
          <strong>Mock payment.</strong> No PayPal is involved in this demo world. The button below plays the part of {p.who} approving on PayPal.
        </p>
        <button className="primary" disabled={p.busy} onClick={() => void p.onMock()}>
          Approve in the mock PayPal
        </button>
      </div>
    );
  }
  if (p.approval.kind === 'UNAVAILABLE') {
    return <Notice kind="warn">PayPal did not return the approval link yet. Please try again in a moment.</Notice>;
  }
  const url = p.approval.url;
  return (
    <div className="paybox">
      <p>
        <strong>Approve on PayPal (Sandbox test account).</strong> Log in with the Sandbox buyer account and approve. Then come back here; FlexSlot checks the order with PayPal
        itself.
      </p>
      <div className="row wrap">
        <a className="button primary" href={url} target="_blank" rel="noopener noreferrer">
          Open PayPal Sandbox
        </a>
        <button disabled={p.busy} onClick={() => void p.onApproved()}>
          I have approved on PayPal
        </button>
      </div>
      <label className="small">
        Approval link (to open in another browser):
        <span className="row">
          <input className="mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </label>
    </div>
  );
}

// ---- intake --------------------------------------------------------------------------------------------------

const REASON: Record<string, string> = {
  AI_TIMEOUT: 'the AI did not answer in time',
  AI_API_ERROR: 'the AI service returned an error',
  AI_INVALID_OUTPUT: "the AI's answer did not pass FlexSlot's checks",
  AI_QUOTA_WORLD: 'this demo world used up its AI calls',
  AI_QUOTA_DAY: "today's AI calls for this server are used up",
  AI_NOT_CONFIGURED: 'the AI is not configured on this server',
};

function WindowsEditor({ windows, onChange }: { windows: Window[]; onChange: (w: Window[]) => void }) {
  const set = (i: number, patch: Partial<Window>) => onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="windows">
      {windows.map((w, i) => (
        <div className="window-row" key={i}>
          <input type="date" aria-label="Date" value={w.date} onChange={(e) => set(i, { date: e.target.value })} />
          <input type="time" aria-label="From" step={900} value={w.start} onChange={(e) => set(i, { start: e.target.value })} />
          <span>–</span>
          <input type="time" aria-label="Until" step={900} value={w.end} onChange={(e) => set(i, { end: e.target.value })} />
          <button type="button" className="link" onClick={() => onChange(windows.filter((_, j) => j !== i))} aria-label="Remove this time window">
            Remove
          </button>
        </div>
      ))}
      {windows.length < 5 && (
        <button type="button" className="link" onClick={() => onChange([...windows, { date: windows.at(-1)?.date ?? '', start: '10:00', end: '12:00' }])}>
          + Add a time window
        </button>
      )}
    </div>
  );
}

export function ConditionsSummary({ c, label }: { c: Conditions; label: string }) {
  return (
    <div className="conditions">
      <p>
        <strong>{label}</strong> (version {c.version}) · <span className="chip muted">{c.source}{c.edited ? ', edited by the person' : ''}</span>
      </p>
      {c.service && <p>Service: {c.service}</p>}
      <ul>
        {c.windows.map((w, i) => (
          <li key={i}>
            {w.date} {w.start}–{w.end}
          </li>
        ))}
      </ul>
      {c.compensation && <p>Fixed compensation for this version: {c.compensation.text}</p>}
      <p className="muted-text quote">“{c.rawText}”</p>
    </div>
  );
}

export function IntakePanel(p: {
  api: Api;
  role: 'A' | 'B';
  header: Header;
  draft: Draft | null;
  blocked: string | null;
  refresh: () => Promise<void>;
  intro: string;
}) {
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [windows, setWindows] = useState<Window[]>([]);
  const [serviceId, setServiceId] = useState<string>('');
  const [result, setResult] = useState<string | null>(null);
  const act = useAction(p.refresh);
  const draft = p.draft;
  const aiName = p.header.modes.ai === 'VERTEX' ? 'Gemini on Vertex AI' : 'the mock AI rules';

  useEffect(() => {
    setWindows(draft?.proposal?.windows ?? []);
    setServiceId(draft?.proposal?.serviceId ?? '');
    setAnswers(draft?.questions.map(() => '') ?? []);
  }, [draft?.id]);

  if (p.blocked === 'CASE_IN_PROGRESS') return <Notice kind="info">Your conditions are locked while a swap proposal is open or being processed.</Notice>;
  if (p.blocked === 'SWAP_DONE') return <Notice kind="info">The swap in this demo world is finished.</Notice>;

  const submit = (useAi: boolean) =>
    act.run(async () => {
      const r = await p.api.post<{ aiFailure: string | null }>('intake/draft', { text, useAi });
      setResult(r.aiFailure ? `The AI could not be used (${REASON[`AI_${r.aiFailure}`] ?? r.aiFailure}). Please fill in the form below yourself.` : null);
      setText('');
    });

  if (!draft) {
    return (
      <div className="intake">
        <p>{p.intro}</p>
        <label>
          In your own words
          <textarea rows={3} maxLength={2000} value={text} placeholder={p.role === 'A' ? p.header.examples.a : p.header.examples.b} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="button" className="link small" onClick={() => setText(p.role === 'A' ? p.header.examples.a : p.header.examples.b)}>
          Use the example text
        </button>
        <div className="row wrap">
          <button className="primary" disabled={act.busy || !text.trim() || !p.header.modes.aiAvailable} onClick={() => void submit(true)}>
            {act.busy ? 'Reading…' : `Structure with ${aiName}`}
          </button>
          <button disabled={act.busy || !text.trim()} onClick={() => void submit(false)}>
            Fill the form myself
          </button>
        </div>
        <p className="small muted-text">The AI only proposes. You check the result and confirm it; the program then checks the times, slots and prices.</p>
        {result && <Notice kind="info">{result}</Notice>}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </div>
    );
  }

  const confirm = () =>
    act.run(async () => {
      const body = p.role === 'A' ? { draftId: draft.id, windows } : { draftId: draft.id, windows, serviceId, stylistId: draft.proposal?.stylistId ?? null };
      const r = await p.api.post<{ version: number; proposal: { feasible: boolean } | null }>('intake/confirm', body);
      setResult(`Saved as version ${r.version}.`);
    });
  const answer = () =>
    act.run(async () => {
      await p.api.post('intake/answer', { draftId: draft.id, answers: answers.filter((a) => a.trim()) });
    });

  return (
    <div className="intake">
      <p className="small">
        Your text: <span className="quote">“{draft.rawText}”</span>
      </p>
      <p className="small">
        Proposed by: <span className="chip muted">{draft.sourceText}</span>
      </p>
      {draft.manualReason && draft.manualReason !== 'CHOSEN_MANUAL' && (
        <Notice kind="warn">
          The AI could not be used ({REASON[draft.manualReason] ?? 'unavailable'}). Please fill in the form yourself. No other AI was used in its place.
        </Notice>
      )}
      {result && <Notice kind="info">{result}</Notice>}
      {draft.questions.length > 0 && (
        <div className="questions">
          <p>
            <strong>Questions before confirming</strong> (vague times are not turned into exact times for you):
          </p>
          {draft.questions.map((q, i) => (
            <label key={i}>
              {q.question}
              <input value={answers[i] ?? ''} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} placeholder="Your answer" />
            </label>
          ))}
          <button disabled={act.busy || !answers.some((a) => a.trim())} onClick={() => void answer()}>
            Send answers to the AI
          </button>
          <p className="small muted-text">Or set the exact times in the form below yourself.</p>
        </div>
      )}
      <div className="form">
        {p.role === 'B' && (
          <label>
            Service
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">Choose…</option>
              {p.header.shop.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMin} min, {s.price.text})
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="small">{p.role === 'A' ? 'You can move into these time windows (the whole service must fit):' : 'You can come only within these time windows:'}</p>
        <WindowsEditor windows={windows} onChange={setWindows} />
        {p.role === 'A' && <p className="small muted-text">Same stylist and same service only. The compensation is fixed by the shop when you confirm: {p.header.shop.compensation.text}.</p>}
      </div>
      <div className="row wrap">
        <button className="primary" disabled={act.busy || windows.length === 0 || (p.role === 'B' && !serviceId)} onClick={() => void confirm()}>
          Confirm these conditions
        </button>
      </div>
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </div>
  );
}
