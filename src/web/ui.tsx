// Shared pieces of the three screens in design 1 "salon" of the HTML mockup v3 (design/mockup-v3, chosen by the
// owner on 2026-11-07): the app bar (the screen named by what it is for, a fixed-width language switch, the modes and
// the demo switcher), two-line action buttons with a busy state that refuses a second send, the swap's slot,
// before/after, amounts, approvals and progress, notices, image slots, the PayPal approval box and the intake panel
// (DESIGN 9). Texts come from i18n.tsx; the server sends its own wording in the same language. Everything shown comes
// from the server's state; no inline styles (CSP).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { explain, type Api } from './api.ts';
import { ART, PHOTOS } from './art.ts';
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

/** One of the 18 SVG icons (decorative: the label next to it carries the meaning). */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ico" aria-hidden="true" focusable="false">
      <use href={`${ART.icons}#fs-${name}`} />
    </svg>
  );
}

/** An amount for display: "US$60.00" (amounts inside sentences keep the server's wording). */
export function Amount({ m, sign }: { m: Money; sign?: '+' | '−' }) {
  const n = (Math.abs(m.minor) / 100).toFixed(2);
  return (
    <span className="money num">
      {sign ?? (m.minor < 0 ? '−' : '')}
      <span className="cur">{m.currency === 'USD' ? 'US$' : `${m.currency} `}</span>
      {n}
    </span>
  );
}

/** "11月9日(月) 14:00〜15:00" / "2026-11-09 14:00–15:00" -> [date, time range]. */
export function splitSpan(span: string): [string, string] {
  const i = span.lastIndexOf(' ');
  return i < 0 ? [span, ''] : [span.slice(0, i), span.slice(i + 1)];
}

/** Two fixed-width choices: the switch never moves when the language changes (phone finding, 2026-11-07). */
export function LangSwitch() {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className="lang-seg" role="group" aria-label={t.langAria}>
      <button type="button" lang="ja" aria-pressed={lang === 'ja'} onClick={() => setLang('ja')}>
        日本語
      </button>
      <button type="button" lang="en" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
        EN
      </button>
    </div>
  );
}

/** Switch between the three screens of the demo world created on this device (same tab). */
export function DemoSwitcher({ worldId, current }: { worldId: string; current: RoleSeg }) {
  const t = useT();
  const demo = loadDemo();
  if (!demo || demo.worldId !== worldId) return null;
  const label: Record<RoleSeg, string> = { owner: t.demoShop, a: 'A', b: 'B' };
  return (
    <nav className="demo-seg" aria-label={t.switchTo}>
      <span className="demo-label">{t.demoLabel}</span>
      {(['owner', 'a', 'b'] as const).map((k) =>
        k === current ? (
          <span key={k} className="on" aria-current="page">
            {label[k]}
          </span>
        ) : (
          <a key={k} href={demo.links[k]}>
            {label[k]}
          </a>
        ),
      )}
    </nav>
  );
}

export function Wordmark() {
  return (
    <span className="brand">
      <span className="logo" aria-hidden="true">
        <Icon name="swap" />
      </span>
      FlexSlot
    </span>
  );
}

/** The top of every screen: brand and language, the screen's title, then the modes and the demo switcher. */
export function AppBar({ title, eyebrow, header, roleSeg }: { title: string; eyebrow: string; header?: Header; roleSeg?: RoleSeg }) {
  const t = useT();
  const m = header?.modes;
  return (
    <header className="appbar">
      <div className="appbar-inner">
        <div className="appbar-row">
          <Wordmark />
          <LangSwitch />
        </div>
        <div className="appbar-title">
          <h1>{title}</h1>
          <p className="eyebrow">{eyebrow}</p>
        </div>
        {header && m && roleSeg && (
          <div className="modes" role="group" aria-label={t.modesAria}>
            <span className={`mode ${m.ai === 'VERTEX' ? 'live' : 'mock'}`}>
              <Icon name="sliders" />
              {m.ai === 'VERTEX' ? t.aiVertex(m.aiModel) : t.aiMock}
            </span>
            <span className={`mode ${m.payment === 'SANDBOX' ? 'live' : 'mock'}`}>
              <Icon name="lock" />
              {m.payment === 'SANDBOX' ? t.paySandbox : t.payMock}
            </span>
            <DemoSwitcher worldId={header.worldId} current={roleSeg} />
          </div>
        )}
      </div>
    </header>
  );
}

/** The frame of a role screen: app bar, main column, side column; the owner gets in-page links (wide screens). */
export function Shell({ header, roleSeg, title, side, children }: { header: Header; roleSeg: RoleSeg; title: string; side?: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <>
      <AppBar title={title} eyebrow={t.eyebrowRole[roleSeg](header.shop.name)} header={header} roleSeg={roleSeg} />
      <div className={`layout${roleSeg === 'owner' ? ' has-rail' : ''}`}>
        {roleSeg === 'owner' && (
          <nav className="rail" aria-label={t.workspace}>
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
        )}
        <main className="content">{children}</main>
        {side && <aside className="side">{side}</aside>}
      </div>
      <footer className="app-foot">
        <DemoNote header={header} />
        <p>{t.appFoot}</p>
      </footer>
    </>
  );
}

// ---- buttons ---------------------------------------------------------------------------------------------------

type BtnKind = 'primary' | 'secondary' | 'ghost';

function BtnInner({ kind, icon, label, sub, busy, arrow }: { kind: BtnKind; icon: IconName; label: ReactNode; sub?: ReactNode; busy: boolean; arrow: boolean }) {
  return (
    <>
      {kind === 'primary' && (
        <span className="bi" aria-hidden="true">
          {busy ? <span className="spin" /> : <Icon name={icon} />}
        </span>
      )}
      <span className="bt">
        <span className="bl">{label}</span>
        {sub && <span className="bs">{sub}</span>}
      </span>
      {kind === 'primary' && arrow && (
        <span className="ba" aria-hidden="true">
          <Icon name="arrow" />
        </span>
      )}
    </>
  );
}

/** A two-line action: what it does, and what happens next. While busy it shows that and accepts no second press. */
export function ActionButton(p: { kind?: BtnKind; icon?: IconName; label: ReactNode; sub?: ReactNode; busy?: boolean; busyLabel?: string; disabled?: boolean; onClick: () => void }) {
  const t = useT();
  const kind = p.kind ?? 'primary';
  const busy = p.busy ?? false;
  return (
    <button type="button" className={`btn btn-${kind}${busy ? ' is-loading' : ''}`} disabled={busy || p.disabled} aria-busy={busy || undefined} onClick={p.onClick}>
      <BtnInner kind={kind} icon={p.icon ?? 'check'} label={busy ? (p.busyLabel ?? t.working) : p.label} sub={busy ? t.workingSub : p.sub} busy={busy} arrow={!busy && !p.disabled} />
    </button>
  );
}

export function ActionLink(p: { kind?: BtnKind; icon?: IconName; label: ReactNode; sub?: ReactNode; href: string; newTab?: boolean }) {
  const kind = p.kind ?? 'primary';
  return (
    <a className={`btn btn-${kind}`} href={p.href} {...(p.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      <BtnInner kind={kind} icon={p.icon ?? 'arrow'} label={p.label} sub={p.sub} busy={false} arrow />
    </a>
  );
}

/** The decision: on phones the main action stays at the bottom while the card is read (`pinned`). */
export function ActionBar({ primary, secondary, note, pinned = true }: { primary?: ReactNode; secondary?: ReactNode; note?: ReactNode; pinned?: boolean }) {
  return (
    <>
      {primary && <div className={`action-bar${pinned ? '' : ' static'}`}>{primary}</div>}
      {secondary && <div className="action-alt">{secondary}</div>}
      {note && <p className="fine">{note}</p>}
    </>
  );
}

// ---- the swap ----------------------------------------------------------------------------------------------------

/** The requested slot in large type, with the shop's local time zone. */
export function SlotHeading({ label, span, tz }: { label: string; span: string; tz: string }) {
  const t = useT();
  const [date, time] = splitSpan(span);
  return (
    <>
      <p className="label">{label}</p>
      <div className="big-slot">
        <span className="cal" aria-hidden="true">
          <Icon name="calendar" />
        </span>
        <div>
          <p className="d">{date}</p>
          <p className="t num">{time}</p>
          <p className="tz">{t.localTime(tz)}</p>
        </div>
      </div>
    </>
  );
}

export function ServiceMeta({ service, stylist }: { service: ReactNode; stylist: ReactNode }) {
  return (
    <p className="meta">
      <span>
        <Icon name="scissors" />
        {service}
      </span>
      <span>
        <Icon name="person" />
        {stylist}
      </span>
    </p>
  );
}

/** A's booking before and after the swap. */
export function MoveCards({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [fd, ft] = splitSpan(from);
  const [td, tt] = splitSpan(to);
  return (
    <div className="move">
      <div className="slot from">
        <span className="lbl">{t.beforeLabel}</span>
        <span className="d">{fd}</span>
        <span className="t num">{ft}</span>
      </div>
      <span className="move-arrow" aria-hidden="true">
        <Icon name="arrow" />
      </span>
      <div className="slot to">
        <span className="lbl">{t.afterLabel}</span>
        <span className="d">{td}</span>
        <span className="t num">{tt}</span>
      </div>
    </div>
  );
}

/** Amounts in a row, shown before the buttons. */
export function AmountGrid({ items }: { items: Array<{ label: string; m: Money; sign?: '+' | '−'; strong?: boolean }> }) {
  return (
    <div className="tiles">
      {items.map((it) => (
        <div key={it.label} className={`tile${it.strong ? ' strong' : ''}`}>
          <span className="tl">{it.label}</span>
          <Amount m={it.m} {...(it.sign ? { sign: it.sign } : {})} />
        </div>
      ))}
    </div>
  );
}

/** Where the swap stands, as six stages; an ended case shows where it stopped. Derived from the server's status. */
type StageState = 'done' | 'current' | 'attention' | 'ended' | 'todo';
const PAYMENT = ['READY', 'PAYMENT_STARTED', 'AUTHORIZING', 'AUTHORIZED', 'CAPTURING', 'PAYMENT_PENDING', 'PAYMENT_UNKNOWN', 'RECONCILING', 'VOID_PENDING'];
/** Statuses in which the payment's result is being checked (no new payment is requested). */
export const CHECKING = ['CAPTURING', 'PAYMENT_PENDING', 'PAYMENT_UNKNOWN', 'RECONCILING'];
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
        <li key={label} className={`step ${states[i]}`} aria-current={states[i] === 'current' || states[i] === 'attention' ? 'step' : undefined}>
          <span className="dot" aria-hidden="true">
            {states[i] === 'done' ? <Icon name="check" /> : states[i] === 'attention' ? '!' : states[i] === 'ended' ? '–' : i + 1}
          </span>
          <span className="sl">{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** The owner's profit estimate: the result first, then each line. */
export function ProfitCard({ profit }: { profit: { lines: Array<{ name: string; sign: number; amount: Money }>; additionalProfit: Money; note: string } }) {
  const t = useT();
  return (
    <section className="card profit-card" aria-labelledby="profit-title">
      <p className="label" id="profit-title">
        {t.profitTitle}
      </p>
      <p className="amount-big plus">
        <Amount m={profit.additionalProfit} sign="+" />
      </p>
      <p className="fine">{t.profitKicker}</p>
      <div className="rows">
        {profit.lines.map((l, i) => (
          <div key={i} className="row">
            <span>{l.name}</span>
            <Amount m={l.amount} sign={l.sign < 0 ? '−' : '+'} />
          </div>
        ))}
      </div>
      <p className="fine">{profit.note}</p>
    </section>
  );
}

/** A place for a photo. Until Codex's images for design 1 arrive, a plain surface in the design's colours. */
export function ImageSlot({ shape = 'photo', icon = 'store', src }: { shape?: 'photo' | 'wide' | 'sq'; icon?: IconName; src?: string | undefined }) {
  return (
    <figure className={`img-slot ${shape}`} aria-hidden="true">
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : (
        <span className="img-ic">
          <Icon name={icon} />
        </span>
      )}
    </figure>
  );
}

/** The salon: its picture, name and the terms of a change. */
export function ShopCard({ header, children }: { header: Header; children?: ReactNode }) {
  const t = useT();
  return (
    <section className="card shop-card">
      <ImageSlot src={PHOTOS.side} />
      {PHOTOS.side && <p className="photo-credit">{t.photoCredit}</p>}
      <p className="shop-name">{header.shop.name}</p>
      <p className="fine">{t.shopSub(header.shop.stylists.join(', '))}</p>
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

/** The three approvals side by side. */
export function ApprovalChips({ c }: { c: CaseView }) {
  const t = useT();
  const one = (label: string, v: string | null) => (
    <div key={label} className={`ap ${v === 'APPROVED' ? 'ok' : v === 'REJECTED' ? 'no' : 'wait'}`}>
      <span className="who">{label}</span>
      <span className="st">
        <Icon name={v === 'APPROVED' ? 'check' : v === 'REJECTED' ? 'close' : 'clock'} />
        {v === 'APPROVED' ? t.apApproved : v === 'REJECTED' ? t.apDeclined : t.apWaiting}
      </span>
    </div>
  );
  return <div className="approvals">{[one(t.apShop, c.approvals.OWNER), one(t.apA, c.approvals.A), one(t.apB, c.approvals.B)]}</div>;
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

type NoticeKind = 'info' | 'wait' | 'warn' | 'error' | 'ok';
const NOTICE_ICON: Record<NoticeKind, IconName> = { info: 'info', wait: 'clock', warn: 'alert', error: 'alert', ok: 'circleCheck' };

/** A notice with an icon; `pending` shows a turning mark while something is being checked. */
export function Notice({ kind, title, pending, children }: { kind: NoticeKind; title?: ReactNode; pending?: boolean; children?: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="nic" aria-hidden="true">
        {pending ? <span className="spin" /> : <Icon name={NOTICE_ICON[kind]} />}
      </span>
      <div className="nbody">
        {title && <strong className="ntitle">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

/**
 * Runs an action with a busy flag and a plain-language error. A second run while one is in flight is ignored, even
 * before the screen has re-rendered (the "Create demo" double tap on the phone, 2026-11-07). `busyKey` names the
 * button that started it, so only that one shows the busy state.
 */
export function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const t = useT();
  const run = async (fn: () => Promise<unknown>, key = 'main') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setBusyKey(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explain(e, t));
    } finally {
      inFlight.current = false;
      setBusy(false);
      setBusyKey(null);
      await refresh();
    }
  };
  return { busy, busyKey, error, run, setError };
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
        <ActionBar pinned={false} primary={<ActionButton icon="lock" label={t.mockApprove} sub={t.mockApproveSub} busy={p.busy} onClick={() => void p.onMock()} />} />
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
      <ActionBar
        pinned={false}
        primary={<ActionLink icon="lock" href={url} newTab label={t.openSandbox} sub={t.openSandboxSub} />}
        secondary={<ActionButton kind="secondary" label={t.iApproved} busy={p.busy} onClick={() => void p.onApproved()} />}
      />
      <label className="small copy-link">
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
  if (p.blocked === 'SWAP_DONE') return <Notice kind="ok">{t.swapDone}</Notice>;

  const submit = (useAi: boolean) =>
    act.run(async () => {
      const r = await p.api.post<{ aiFailure: string | null }>('intake/draft', { text, useAi });
      setResult(r.aiFailure ? t.aiCouldNotBeUsed(t.aiFail[`AI_${r.aiFailure}`] ?? r.aiFailure) : null);
      setText('');
    }, useAi ? 'ai' : 'manual');

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
        <ActionBar
          pinned={false}
          primary={
            <ActionButton
              icon="sliders"
              label={t.structureWith(aiName)}
              sub={t.structureSub}
              busy={act.busyKey === 'ai'}
              busyLabel={t.reading}
              disabled={act.busy || !text.trim() || !p.header.modes.aiAvailable}
              onClick={() => void submit(true)}
            />
          }
          secondary={<ActionButton kind="secondary" label={t.fillMyself} busy={act.busyKey === 'manual'} disabled={act.busy || !text.trim()} onClick={() => void submit(false)} />}
          note={t.aiOnlyProposes}
        />
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
    }, 'confirm');
  const answer = () =>
    act.run(async () => {
      await p.api.post('intake/answer', { draftId: draft.id, answers: answers.filter((a) => a.trim()) });
    }, 'answer');

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
          <ActionBar pinned={false} secondary={<ActionButton kind="secondary" label={t.sendAnswers} busy={act.busyKey === 'answer'} disabled={act.busy || !answers.some((a) => a.trim())} onClick={() => void answer()} />} />
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
      <ActionBar
        pinned={false}
        primary={
          <ActionButton
            label={t.confirmConditions}
            sub={t.confirmSub}
            busy={act.busyKey === 'confirm'}
            disabled={act.busy || windows.length === 0 || (p.role === 'B' && !serviceId)}
            onClick={() => void confirm()}
          />
        }
      />
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </div>
  );
}
