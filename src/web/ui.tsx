// Shared pieces of the three screens: the app frame and mode bar (DESIGN 10), status badges, the swap's slot,
// before/after and amounts (design v2 from Codex, 2026-11-07), the PayPal approval box, and the intake panel (free
// text -> AI proposal or manual form -> the person's confirmation, DESIGN 9). Texts come from i18n.tsx (English or
// Japanese); the server sends its own wording in the same language. Everything shown comes from the server's state.

import { useEffect, useState, type ReactNode } from 'react';
import { explain, type Api } from './api.ts';
import { ART } from './art.ts';
import { loadDemo, type RoleSeg } from './demo-links.ts';
import { showDate, useLang, useT } from './i18n.tsx';
import type { Approval, CaseView, Conditions, Draft, Header, Money, Step, Window } from './types.ts';

export type IconName =
  | 'calendar'
  | 'swap'
  | 'arrow'
  | 'chevron'
  | 'down'
  | 'check'
  | 'circleCheck'
  | 'clock'
  | 'lock'
  | 'receipt'
  | 'person'
  | 'scissors'
  | 'info'
  | 'alert'
  | 'close'
  | 'refund'
  | 'sliders'
  | 'store';

/** One of Codex's 18 SVG icons (decorative: the label next to it carries the meaning). */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ico" aria-hidden="true" focusable="false">
      <use href={`${ART.icons}#fs-${name}`} />
    </svg>
  );
}

/** An amount for display: "$60.00 USD" (amounts inside sentences keep the server's wording). */
export function Amount({ m, sign }: { m: Money; sign?: '+' | '−' }) {
  const n = (Math.abs(m.minor) / 100).toFixed(2);
  return (
    <span className="amount num">
      {sign ?? (m.minor < 0 ? '−' : '')}
      {m.currency === 'USD' ? '$' : ''}
      {n}
      <span className="currency">{m.currency}</span>
    </span>
  );
}

/** "11月9日(月) 14:00〜15:00" / "2026-11-09 14:00–15:00" -> [date, time range]. */
export function splitSpan(span: string): [string, string] {
  const i = span.lastIndexOf(' ');
  return i < 0 ? [span, ''] : [span.slice(0, i), span.slice(i + 1)];
}

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

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="mark" aria-hidden="true" />
      FlexSlot
    </span>
  );
}

export function TopBar({ header, roleName, roleSeg }: { header: Header; roleName: string; roleSeg: RoleSeg }) {
  const m = header.modes;
  const t = useT();
  return (
    <header className="topbar">
      <div className="brand">
        <Wordmark />
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

/** The frame of a role screen: the owner gets a navy side rail with in-page links (wide screens only). */
export function Shell({ header, roleName, roleSeg, children }: { header: Header; roleName: string; roleSeg: RoleSeg; children: ReactNode }) {
  const t = useT();
  return (
    <div className={`shell ${roleSeg === 'owner' ? 'with-rail' : 'customer'}`}>
      {roleSeg === 'owner' && (
        <aside className="sidebar">
          <Wordmark />
          <p className="rail-label">{t.workspace}</p>
          <nav className="rail-nav" aria-label={t.workspace}>
            <a href="#swap">
              <Icon name="swap" />
              {t.nav.swap}
            </a>
            <a href="#bookings">
              <Icon name="calendar" />
              {t.nav.bookings}
            </a>
            <a href="#conditions">
              <Icon name="sliders" />
              {t.nav.conditions}
            </a>
            <a href="#history">
              <Icon name="receipt" />
              {t.nav.history}
            </a>
          </nav>
          <div className="rail-foot">
            <p className="rail-shop">
              <Icon name="store" />
              {header.shop.name}
            </p>
            <p className="rail-note">{t.shopFoot(header.shop.stylists.join(', '))}</p>
          </div>
        </aside>
      )}
      <div className="workspace">
        <TopBar header={header} roleName={roleName} roleSeg={roleSeg} />
        <main>{children}</main>
      </div>
    </div>
  );
}

export function PageHeading({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return (
    <div className="page-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="lead">{lead}</p>
    </div>
  );
}

/** The requested slot in large type, with the shop's local time zone. */
export function SlotHeading({ label, span, tz }: { label: string; span: string; tz: string }) {
  const t = useT();
  const [date, time] = splitSpan(span);
  return (
    <div className="slot-heading">
      <div>
        <p className="slot-label">{label}</p>
        <p className="date">{date}</p>
        <p className="time num">{time}</p>
        <p className="time-zone">{t.localTime(tz)}</p>
      </div>
      <span className="slot-symbol" aria-hidden="true">
        <Icon name="calendar" />
      </span>
    </div>
  );
}

/** A's booking before and after the swap. */
export function MoveCards({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [fd, ft] = splitSpan(from);
  const [td, tt] = splitSpan(to);
  return (
    <div className="move">
      <div className="move-col">
        <p className="move-label">
          <Icon name="calendar" />
          {t.fromLabel}
        </p>
        <p className="move-date">{fd}</p>
        <p className="move-time num">{ft}</p>
      </div>
      <span className="move-arrow" aria-hidden="true">
        <Icon name="arrow" />
      </span>
      <div className="move-col to">
        <p className="move-label">
          <Icon name="swap" />
          {t.toLabel}
        </p>
        <p className="move-date">{td}</p>
        <p className="move-time num">{tt}</p>
      </div>
    </div>
  );
}

/** Amounts in a row, shown before the buttons. */
export function AmountGrid({ items }: { items: Array<{ label: string; m: Money; sign?: '+' | '−'; strong?: boolean }> }) {
  return (
    <div className="amount-grid">
      {items.map((it) => (
        <div key={it.label} className={it.strong ? 'strong' : ''}>
          <p className="amount-label">{it.label}</p>
          <Amount m={it.m} {...(it.sign ? { sign: it.sign } : {})} />
        </div>
      ))}
    </div>
  );
}

/** Where the swap stands, as six stages; an ended case shows where it stopped. Derived from the server's status. */
type StageState = 'done' | 'current' | 'attention' | 'ended' | 'todo';
const PAYMENT = ['READY', 'PAYMENT_STARTED', 'AUTHORIZING', 'AUTHORIZED', 'CAPTURING', 'PAYMENT_PENDING', 'PAYMENT_UNKNOWN', 'RECONCILING', 'VOID_PENDING'];
export function stagesOf(c: CaseView): StageState[] {
  const s = c.status;
  const at = (i: number, here: StageState): StageState[] => [0, 1, 2, 3, 4, 5].map((k) => (k < i ? 'done' : k === i ? here : 'todo'));
  if (s === 'COMPLETED') return at(6, 'done');
  if (s === 'AWAITING_APPROVAL' || s === 'A_ACCEPTED') return at(1, 'current');
  if (PAYMENT.includes(s)) return at(2, c.steps.authorizationRelease?.state === 'ATTENTION' ? 'attention' : 'current');
  if (s === 'CAPTURED' || s === 'BOOKING_COMMIT_PENDING') return at(3, 'current');
  if (s === 'BOOKING_COMMITTED' || s === 'REFUND_PENDING') return at(4, 'current');
  if (s === 'REFUND_FAILED') return at(4, 'attention');
  if (s === 'B_REFUND_PENDING') return at(3, 'current');
  if (s === 'B_REFUND_FAILED') return at(3, 'attention');
  if (s === 'COMPENSATED') return at(3, 'ended');
  // REJECTED / EXPIRED: before or during the payment.
  return at(c.steps.bPayment.state === 'NONE' ? 1 : 2, 'ended');
}

export function CaseProgress({ c }: { c: CaseView }) {
  const t = useT();
  const states = stagesOf(c);
  return (
    <ol className="stepper" aria-label={t.progressAria}>
      {t.stages.map((label, i) => (
        <li key={label} className={states[i]} aria-current={states[i] === 'current' || states[i] === 'attention' ? 'step' : undefined}>
          <span className="step-dot" aria-hidden="true">
            {states[i] === 'done' ? <Icon name="check" /> : states[i] === 'attention' ? '!' : states[i] === 'ended' ? '–' : i + 1}
          </span>
          <span className="step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** The owner's profit estimate as a navy card: the result first, then each line. */
export function ProfitCard({ profit }: { profit: { lines: Array<{ name: string; sign: number; amount: Money }>; additionalProfit: Money; note: string } }) {
  const t = useT();
  return (
    <section className="panel profit-card" aria-labelledby="profit-title">
      <p className="profit-label" id="profit-title">
        <Icon name="receipt" />
        {t.profitTitle}
      </p>
      <p className="profit-amount">
        <Amount m={profit.additionalProfit} sign="+" />
      </p>
      <p className="profit-kicker">{t.profitKicker}</p>
      <div className="profit-breakdown">
        {profit.lines.map((l, i) => (
          <div key={i} className={i === 0 ? 'revenue' : ''}>
            <span>{l.name}</span>
            <strong>
              <Amount m={l.amount} sign={l.sign < 0 ? '−' : '+'} />
            </strong>
          </div>
        ))}
      </div>
      <p className="profit-foot">{profit.note}</p>
    </section>
  );
}

/** The salon: a small supporting photo (fictional, AI-generated) and the shop's terms. */
export function ShopCard({ header, children }: { header: Header; children?: ReactNode }) {
  const t = useT();
  return (
    <section className="panel shop-card">
      <figure className="photo-card">
        <img src={ART.salon} alt="" aria-hidden="true" width={900} height={600} loading="lazy" />
      </figure>
      <p className="photo-credit">{t.photoCredit}</p>
      <p className="shop-name">{header.shop.name}</p>
      <p className="small muted-text">{t.shopSub(header.shop.stylists.join(', '))}</p>
      {children}
    </section>
  );
}

export function DemoNote({ header }: { header: Header }) {
  const t = useT();
  const { lang } = useLang();
  return <p className="demo-note">{t.demoNote(header.shop.name, header.shop.stylists.join(lang === 'ja' ? '、' : ', '), header.shop.hours, header.shop.timeZone, header.serverTime)}</p>;
}

export function Section({ title, children, aside, id }: { title: ReactNode; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
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
  const icon: IconName = cls === 'ok' ? 'circleCheck' : cls === 'bad' ? 'alert' : cls === 'muted' ? 'info' : 'clock';
  return (
    <span className={`badge ${cls}`}>
      <Icon name={icon} />
      {c.statusLabel}
    </span>
  );
}

export function ApprovalChips({ c }: { c: CaseView }) {
  const t = useT();
  const one = (label: string, v: string | null) => (
    <span className={`approval-item ${v === 'APPROVED' ? 'approved' : v === 'REJECTED' ? 'declined' : ''}`}>
      <Icon name={v === 'APPROVED' ? 'check' : v === 'REJECTED' ? 'close' : 'clock'} />
      {label}: {v === 'APPROVED' ? t.apApproved : v === 'REJECTED' ? t.apDeclined : t.apWaiting}
    </span>
  );
  return (
    <div className="approval-row">
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
