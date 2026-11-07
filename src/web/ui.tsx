// Shared pieces of the three screens in the crafted version of the HTML mockup v4 (design/mockup-v4) with the
// terracotta accent, both chosen by the owner on 2026-11-07: the app bar (the screen named by what it is for, a
// fixed-width language switch, the modes and the demo switcher), photographs under a warm veil, seals, two-line action
// buttons with a busy state that refuses a second send, the swap's slot, before/after, ledgers, approvals as people,
// the growing progress line, the profit bar, notices, the PayPal approval box and the intake panel (DESIGN 9). Texts
// come from i18n.tsx; the server sends its own wording in the same language. Everything shown comes from the server's
// state. No inline style attributes (CSP): the few computed values (a line's width, a photo's framing) are set
// through the style property, which React applies via the CSSOM.

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { explain, type Api } from './api.ts';
import { ART, PHOTOS, type PhotoSlot } from './art.ts';
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

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Counts a number up once when it first appears (not on every refresh); exact at once with reduced motion. */
function useCountUp(target: number, on: boolean): number {
  const [v, setV] = useState(on && !reduced() ? 0 : target);
  useEffect(() => {
    if (!on || reduced()) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      setV(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, on]);
  return v;
}

/** An amount for display: "US$60.00" (amounts inside sentences keep the server's wording). `count` counts it up. */
export function Amount({ m, sign, count = false }: { m: Money; sign?: '+' | '−'; count?: boolean }) {
  const shown = useCountUp(Math.abs(m.minor) / 100, count);
  return (
    <span className="money num">
      {sign ?? (m.minor < 0 ? '−' : '')}
      <span className="cur">{m.currency === 'USD' ? 'US$' : `${m.currency} `}</span>
      {shown.toFixed(2)}
    </span>
  );
}

/** "11月9日(月) 14:00〜15:00" / "2026-11-09 14:00–15:00" -> [date, time range]. */
export function splitSpan(span: string): [string, string] {
  const i = span.lastIndexOf(' ');
  return i < 0 ? [span, ''] : [span.slice(0, i), span.slice(i + 1)];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** The small calendar leaf: "11月" / "NOV" and the day, read from the server's date text. */
function calParts(date: string): [string, string] | null {
  const ja = /(\d{1,2})月(\d{1,2})日/.exec(date);
  if (ja) return [`${ja[1]}月`, ja[2]!];
  const en = /\d{4}-(\d{2})-(\d{2})/.exec(date);
  if (en) return [MONTHS[Number(en[1]) - 1] ?? '', String(Number(en[2]))];
  return null;
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
      <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M9 12.5h13l-3.2-3.2M23 19.5H10l3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="wm">FlexSlot</span>
    </span>
  );
}

/** Small italic caption above a title (PROPOSAL, PROGRESS…): decoration, the same in both languages. */
export const KICKER = { owner: 'FOR THE SHOP', a: 'FOR CUSTOMER A', b: 'FOR CUSTOMER B', landing: 'BOOKING SWAPS' } as const;

/** The top of every screen: brand and language, the screen's title, then the modes and the demo switcher. */
export function AppBar({ k, title, eyebrow, header, roleSeg }: { k: string; title: string; eyebrow: string; header?: Header; roleSeg?: RoleSeg }) {
  const t = useT();
  const m = header?.modes;
  return (
    <header className="appbar">
      <div className="appbar-in">
        <div className="bar-row">
          <Wordmark />
          <LangSwitch />
        </div>
        <div className="titles">
          <p className="k">{k}</p>
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

export function Footer({ header }: { header?: Header }) {
  const t = useT();
  return (
    <footer className="foot">
      <div className="orn">
        <Wordmark />
      </div>
      {header && <DemoNote header={header} />}
      <p>{t.appFoot}</p>
    </footer>
  );
}

/** The frame of a role screen: app bar, main column, side column; the owner gets in-page links (wide screens). */
export function Shell({ header, roleSeg, title, side, children }: { header: Header; roleSeg: RoleSeg; title: string; side?: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <>
      <AppBar k={KICKER[roleSeg]} title={title} eyebrow={t.eyebrowRole[roleSeg](header.shop.name)} header={header} roleSeg={roleSeg} />
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
      <Footer header={header} />
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

// ---- cards and photographs --------------------------------------------------------------------------------------

/** A card's head: a small italic caption, the title, and something on the right (a status). */
export function CardHead({ k, title, aside }: { k: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="ch">
      <div>
        <p className="ck">{k}</p>
        <h2>{title}</h2>
      </div>
      {aside}
    </div>
  );
}

/** A numbered section inside a card, with a rule that fades out. */
export function Sec({ no, children }: { no: string; children: ReactNode }) {
  return (
    <div className="sec">
      <span className="sec-no">{no}</span>
      <span>{children}</span>
    </div>
  );
}

/** A photograph filling its box (decorative). */
export function Photo({ slot }: { slot: PhotoSlot }) {
  const p = PHOTOS[slot];
  return <img className="ph" src={p.src} alt="" aria-hidden="true" loading="lazy" style={{ objectPosition: p.pos }} />;
}

/** The round seal pressed on completion: a ring of words and a check that draws itself. */
export function Seal({ words, className, backdrop }: { words: string; className: string; backdrop?: boolean }) {
  const id = `ring${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg className={className} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <path id={id} d="M60,60 m-43,0 a43,43 0 1,1 86,0 a43,43 0 1,1 -86,0" />
      </defs>
      {backdrop && <circle cx="60" cy="60" r="57" fill="rgba(255,253,249,0.82)" />}
      <circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" strokeWidth=".8" />
      <circle cx="60" cy="60" r="33" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <text>
        <textPath href={`#${id}`}>{words}</textPath>
      </text>
      <path className="chk" d="M45 61l10 10 21-23" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A large card on a photograph: what is asked, or what happened (`done`, with a seal). */
export function PhotoHero({ slot, kicker, icon, title, done, seal, children }: { slot: PhotoSlot; kicker: string; icon: IconName; title: ReactNode; done?: boolean; seal?: string; children?: ReactNode }) {
  return (
    <section className={`photo-hero${done ? ' done' : ''}`}>
      <Photo slot={slot} />
      <div className="veil" />
      <div className="frame" />
      {seal && <Seal className="seal" words={seal} />}
      <div className="ph-body">
        <span className="kicker">
          <Icon name={icon} />
          {kicker}
        </span>
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  );
}

// ---- the swap ----------------------------------------------------------------------------------------------------

/** The requested slot in large type with a calendar leaf, and the shop's local time zone. */
export function SlotHeading({ span, tz }: { span: string; tz: string }) {
  const t = useT();
  const [date, time] = splitSpan(span);
  const leaf = calParts(date);
  return (
    <div className="big-slot">
      {leaf ? (
        <div className="cal" aria-hidden="true">
          <b>{leaf[0]}</b>
          <span>{leaf[1]}</span>
        </div>
      ) : null}
      <div>
        <p className="d">{date}</p>
        <p className="t num">{time}</p>
        <p className="tz">{t.localTime(tz)}</p>
      </div>
    </div>
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
      <span className="mv" aria-hidden="true">
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

/** Label ······ value rows (a receipt). */
export function Ledger({ rows }: { rows: Array<{ k: ReactNode; v: ReactNode; total?: boolean; key?: string }> }) {
  return (
    <div className="ledger">
      {rows.map((r, i) => (
        <div key={r.key ?? i} className={`lg${r.total ? ' total' : ''}`}>
          <span>{r.k}</span>
          <i aria-hidden="true" />
          <b>{r.v}</b>
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
  const reached = states.filter((s) => s === 'done').length;
  const width = (Math.min(reached, 5) / 5) * 83.34;
  return (
    <ol className="stepper" aria-label={t.progressAria}>
      <span className="fill" aria-hidden="true" style={{ '--w': `${width}%` } as CSSProperties} />
      {t.stages.map((label, i) => (
        <li key={label} className={`step ${states[i]}`} aria-current={states[i] === 'current' || states[i] === 'attention' ? 'step' : undefined}>
          <span className="dot" aria-hidden="true">
            {states[i] === 'done' ? <Icon name="check" /> : states[i] === 'attention' ? '!' : states[i] === 'ended' ? '–' : i + 1}
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** The owner's profit estimate: the result, a bar of where the extra revenue goes, then each line. */
export function ProfitCard({ profit }: { profit: { lines: Array<{ name: string; sign: number; amount: Money }>; additionalRevenue: Money; additionalProfit: Money; note: string } }) {
  const t = useT();
  const revenue = Math.max(1, profit.additionalRevenue.minor);
  const parts = [
    { name: t.kpiProfit, m: profit.additionalProfit, sign: '+' as const },
    ...profit.lines.filter((l) => l.sign < 0).map((l) => ({ name: l.name, m: l.amount, sign: '−' as const })),
  ];
  return (
    <section className="card" aria-labelledby="profit-title">
      <p className="ck">IF THIS SWAP GOES AHEAD</p>
      <h2 id="profit-title">{t.profitHead}</h2>
      <p className="amount-big">
        <Amount m={profit.additionalProfit} sign="+" count />
      </p>
      <p className="fine">{t.profitOf(profit.additionalRevenue.text)}</p>
      <div className="pbar" aria-hidden="true">
        {parts.map((p, i) => (
          <span key={i} className={`seg${i}`} style={{ width: `${(Math.max(0, p.m.minor) / revenue) * 100}%` }} />
        ))}
      </div>
      <div className="ledger legend">
        {parts.map((p, i) => (
          <div key={i} className="lg">
            <span className={`key seg${i}`} aria-hidden="true" />
            <span>{p.name}</span>
            <i aria-hidden="true" />
            <b>
              <Amount m={p.m} sign={p.sign} />
            </b>
          </div>
        ))}
      </div>
      <p className="fine">{profit.note}</p>
    </section>
  );
}

/** The salon: its picture, name and (on the customers' screens) the terms of a change. */
export function ShopCard({ header, children }: { header: Header; children?: ReactNode }) {
  const t = useT();
  return (
    <section className="card shop">
      <div className="pic">
        <Photo slot="station" />
      </div>
      <div className="shop-in">
        <p className="ck">THE SALON</p>
        <h3>{header.shop.name}</h3>
        <p className="fine">{t.shopSub(header.shop.stylists.join(', '))}</p>
        <p className="photo-credit">{t.photoCredit}</p>
        {children}
      </div>
    </section>
  );
}

export function DemoNote({ header }: { header: Header }) {
  const t = useT();
  const { lang } = useLang();
  return <p className="demo-note">{t.demoNote(header.shop.name, header.shop.stylists.join(lang === 'ja' ? '、' : ', '), header.shop.hours, header.shop.timeZone, header.serverTime)}</p>;
}

export function Section({ k, title, children, aside, id }: { k: string; title: ReactNode; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      <CardHead k={k} title={title} aside={aside} />
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

/** The three approvals as people; `me` marks the viewer, whose pending turn pulses. */
export function People({ c, me }: { c: CaseView; me: 'OWNER' | 'A' | 'B' }) {
  const t = useT();
  const one = (who: 'OWNER' | 'A' | 'B', badge: string, label: string) => {
    const v = c.approvals[who];
    const cls = v === 'APPROVED' ? 'ok' : v === 'REJECTED' ? 'no' : who === me ? 'you' : 'wait';
    const status = v === 'APPROVED' ? (who === 'A' ? t.apAgreed : t.apApproved) : v === 'REJECTED' ? t.apDeclined : who === me ? t.apYou : t.apWaiting;
    return (
      <div key={who} className={`pp ${cls}`}>
        <span className="av" aria-hidden="true">
          {badge}
          {v === 'APPROVED' && (
            <span className="bdg">
              <Icon name="check" />
            </span>
          )}
        </span>
        <b>{who === me ? `${label}（${t.you}）`.replace('（You）', ' (you)') : label}</b>
        <small>{status}</small>
      </div>
    );
  };
  return <div className="people">{[one('OWNER', t.shopBadge, t.apShop), one('A', 'A', t.apA), one('B', 'B', t.apB)]}</div>;
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

/** A notice with an accent edge and an icon; `pending` shows a turning mark while something is being checked. */
export function Notice({ kind, title, pending, children }: { kind: NoticeKind; title?: ReactNode; pending?: boolean; children?: ReactNode }) {
  return (
    <div className={`note ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
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
