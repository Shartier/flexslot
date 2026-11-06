// Shared pieces of the three screens: the mode bar (DESIGN 10), status chips, the PayPal approval box, and the
// intake panel (free text -> AI proposal or manual form -> the person's confirmation, DESIGN 9). Texts come from
// i18n.tsx (English or Japanese); the server sends its own wording in the same language.

import { useEffect, useState, type ReactNode } from 'react';
import { explain, type Api } from './api.ts';
import { loadDemo, type RoleSeg } from './demo-links.ts';
import { showDate, useLang, useT } from './i18n.tsx';
import type { Approval, CaseView, Conditions, Draft, Header, Step, Window } from './types.ts';

export function LangSwitch() {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <button type="button" className="lang-switch" onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')} aria-label={t.langSwitchLabel} lang={lang === 'ja' ? 'en' : 'ja'}>
      {t.langSwitch}
    </button>
  );
}

/** Switch between the three screens of the demo world created on this device (same tab). */
export function DemoSwitcher({ worldId, current }: { worldId: string; current: RoleSeg }) {
  const t = useT();
  const demo = loadDemo();
  if (!demo || demo.worldId !== worldId) return null;
  const label: Record<RoleSeg, string> = { owner: t.roleOwner, a: t.roleA, b: t.roleB };
  return (
    <nav className="switcher" aria-label={t.switchTo}>
      <span className="small muted-text">{t.switchTo}</span>
      {(['owner', 'a', 'b'] as const).map((k) =>
        k === current ? (
          <span key={k} className="chip ok" aria-current="page">
            {label[k]}
          </span>
        ) : (
          <a key={k} className="chip link-chip" href={demo.links[k]}>
            {label[k]}
          </a>
        ),
      )}
    </nav>
  );
}

export function TopBar({ header, roleName, roleSeg }: { header: Header; roleName: string; roleSeg: RoleSeg }) {
  const m = header.modes;
  const t = useT();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">FlexSlot</span>
        <span className="role">{roleName}</span>
      </div>
      <div className="modes" aria-label={t.modesAria}>
        <span className={`mode ${m.ai === 'VERTEX' ? 'live' : 'mock'}`}>{m.ai === 'VERTEX' ? t.aiVertex(m.aiModel) : t.aiMock}</span>
        <span className={`mode ${m.payment === 'SANDBOX' ? 'live' : 'mock'}`}>{m.payment === 'SANDBOX' ? t.paySandbox : t.payMock}</span>
        <LangSwitch />
      </div>
      <DemoSwitcher worldId={header.worldId} current={roleSeg} />
    </header>
  );
}

export function DemoNote({ header }: { header: Header }) {
  const t = useT();
  const { lang } = useLang();
  return <p className="demo-note">{t.demoNote(header.shop.name, header.shop.stylists.join(lang === 'ja' ? '、' : ', '), header.shop.hours, header.shop.timeZone, header.serverTime)}</p>;
}

export function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
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
  const t = useT();
  const one = (label: string, v: string | null) => (
    <span className={`chip ${v === 'APPROVED' ? 'ok' : v === 'REJECTED' ? 'bad' : 'muted'}`}>
      {label}: {v === 'APPROVED' ? t.apApproved : v === 'REJECTED' ? t.apDeclined : t.apWaiting}
    </span>
  );
  return (
    <div className="chips">
      {one(t.apShop, c.approvals.OWNER)}
      {one(t.apA, c.approvals.A)}
      {one(t.apB, c.approvals.B)}
    </div>
  );
}

export function Events({ c }: { c: CaseView }) {
  const t = useT();
  if (!c.events.length) return null;
  return (
    <details className="events">
      <summary>{t.timeline}</summary>
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
  const t = useT();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explain(e, t));
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
export function ApprovalBox(p: { approval: Approval | null; onApproved: () => Promise<void>; onMock: () => Promise<void>; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const t = useT();
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
          <strong>{t.mockPayTitle}</strong> {t.mockPayBody}
        </p>
        <button className="primary" disabled={p.busy} onClick={() => void p.onMock()}>
          {t.mockApprove}
        </button>
      </div>
    );
  }
  if (p.approval.kind === 'UNAVAILABLE') {
    return <Notice kind="warn">{t.approvalUnavailable}</Notice>;
  }
  const url = p.approval.url;
  return (
    <div className="paybox">
      <p>
        <strong>{t.sandboxTitle}</strong> {t.sandboxBody}
      </p>
      <div className="row wrap">
        <a className="button primary" href={url} target="_blank" rel="noopener noreferrer">
          {t.openSandbox}
        </a>
        <button disabled={p.busy} onClick={() => void p.onApproved()}>
          {t.iApproved}
        </button>
      </div>
      <label className="small">
        {t.approvalLink}
        <span className="row">
          <input className="mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? t.copied : t.copy}
          </button>
        </span>
      </label>
    </div>
  );
}

// ---- intake --------------------------------------------------------------------------------------------------

function WindowsEditor({ windows, onChange }: { windows: Window[]; onChange: (w: Window[]) => void }) {
  const t = useT();
  const { lang } = useLang();
  const set = (i: number, patch: Partial<Window>) => onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="windows">
      {windows.map((w, i) => (
        <div className="window-row" key={i}>
          <input type="date" aria-label={t.date} value={w.date} onChange={(e) => set(i, { date: e.target.value })} />
          <input type="time" aria-label={t.from} step={900} value={w.start} onChange={(e) => set(i, { start: e.target.value })} />
          <span>{lang === 'ja' ? '〜' : '–'}</span>
          <input type="time" aria-label={t.until} step={900} value={w.end} onChange={(e) => set(i, { end: e.target.value })} />
          <button type="button" className="link" onClick={() => onChange(windows.filter((_, j) => j !== i))} aria-label={t.removeWindow}>
            {t.remove}
          </button>
        </div>
      ))}
      {windows.length < 5 && (
        <button type="button" className="link" onClick={() => onChange([...windows, { date: windows.at(-1)?.date ?? '', start: '10:00', end: '12:00' }])}>
          {t.addWindow}
        </button>
      )}
    </div>
  );
}

export function ConditionsSummary({ c, label }: { c: Conditions; label: string }) {
  const t = useT();
  const { lang } = useLang();
  return (
    <div className="conditions">
      <p>
        <strong>{label}</strong> {t.version(c.version)} · <span className="chip muted">{c.source}{c.edited ? t.editedByPerson : ''}</span>
      </p>
      {c.service && <p>{t.serviceLine(c.service)}</p>}
      <ul>
        {c.windows.map((w, i) => (
          <li key={i}>
            {showDate(w.date, lang)} {w.start}
            {lang === 'ja' ? '〜' : '–'}
            {w.end}
          </li>
        ))}
      </ul>
      {c.compensation && <p>{t.compForVersion(c.compensation.text)}</p>}
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
  const t = useT();
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [windows, setWindows] = useState<Window[]>([]);
  const [serviceId, setServiceId] = useState<string>('');
  const [result, setResult] = useState<string | null>(null);
  const act = useAction(p.refresh);
  const draft = p.draft;
  const aiName = p.header.modes.ai === 'VERTEX' ? t.aiNameVertex : t.aiNameMock;
  const example = p.role === 'A' ? p.header.examples.a : p.header.examples.b;

  useEffect(() => {
    setWindows(draft?.proposal?.windows ?? []);
    setServiceId(draft?.proposal?.serviceId ?? '');
    setAnswers(draft?.questions.map(() => '') ?? []);
  }, [draft?.id]);

  if (p.blocked === 'CASE_IN_PROGRESS') return <Notice kind="info">{t.lockedInProgress}</Notice>;
  if (p.blocked === 'SWAP_DONE') return <Notice kind="info">{t.swapDone}</Notice>;

  const submit = (useAi: boolean) =>
    act.run(async () => {
      const r = await p.api.post<{ aiFailure: string | null }>('intake/draft', { text, useAi });
      setResult(r.aiFailure ? t.aiCouldNotBeUsed(t.aiFail[`AI_${r.aiFailure}`] ?? r.aiFailure) : null);
      setText('');
    });

  if (!draft) {
    return (
      <div className="intake">
        <p>{p.intro}</p>
        <label>
          {t.inYourWords}
          <textarea rows={3} maxLength={2000} value={text} placeholder={example} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="button" className="link small" onClick={() => setText(example)}>
          {t.useExample}
        </button>
        <div className="row wrap">
          <button className="primary" disabled={act.busy || !text.trim() || !p.header.modes.aiAvailable} onClick={() => void submit(true)}>
            {act.busy ? t.reading : t.structureWith(aiName)}
          </button>
          <button disabled={act.busy || !text.trim()} onClick={() => void submit(false)}>
            {t.fillMyself}
          </button>
        </div>
        <p className="small muted-text">{t.aiOnlyProposes}</p>
        {result && <Notice kind="info">{result}</Notice>}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </div>
    );
  }

  const confirm = () =>
    act.run(async () => {
      const body = p.role === 'A' ? { draftId: draft.id, windows } : { draftId: draft.id, windows, serviceId, stylistId: draft.proposal?.stylistId ?? null };
      const r = await p.api.post<{ version: number; proposal: { feasible: boolean } | null }>('intake/confirm', body);
      setResult(t.savedAsVersion(r.version));
    });
  const answer = () =>
    act.run(async () => {
      await p.api.post('intake/answer', { draftId: draft.id, answers: answers.filter((a) => a.trim()) });
    });

  return (
    <div className="intake">
      <p className="small">
        {t.yourText} <span className="quote">“{draft.rawText}”</span>
      </p>
      <p className="small">
        {t.proposedBy} <span className="chip muted">{draft.sourceText}</span>
      </p>
      {draft.manualReason && draft.manualReason !== 'CHOSEN_MANUAL' && <Notice kind="warn">{t.aiNotUsedNotice(t.aiFail[draft.manualReason] ?? t.aiUnavailable)}</Notice>}
      {result && <Notice kind="info">{result}</Notice>}
      {draft.questions.length > 0 && (
        <div className="questions">
          <p>
            <strong>{t.questionsTitle}</strong>
            {t.questionsNote}
          </p>
          {draft.questions.map((q, i) => (
            <label key={i}>
              {q.question}
              <input value={answers[i] ?? ''} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} placeholder={t.yourAnswer} />
            </label>
          ))}
          <button disabled={act.busy || !answers.some((a) => a.trim())} onClick={() => void answer()}>
            {t.sendAnswers}
          </button>
          <p className="small muted-text">{t.orSetTimes}</p>
        </div>
      )}
      <div className="form">
        {p.role === 'B' && (
          <label>
            {t.service}
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">{t.choose}</option>
              {p.header.shop.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {t.serviceOption(s.name, s.durationMin, s.price.text)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="small">{p.role === 'A' ? t.windowsA : t.windowsB}</p>
        <WindowsEditor windows={windows} onChange={setWindows} />
        {p.role === 'A' && <p className="small muted-text">{t.aSameNote(p.header.shop.compensation.text)}</p>}
      </div>
      <div className="row wrap">
        <button className="primary" disabled={act.busy || windows.length === 0 || (p.role === 'B' && !serviceId)} onClick={() => void confirm()}>
          {t.confirmConditions}
        </button>
      </div>
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </div>
  );
}
