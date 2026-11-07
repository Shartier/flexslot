// The existing customer's screen (A) and the new customer's screen (B) (SPEC 3), design 1 "salon" of the HTML
// mockup v3: a large card that says what is asked or what happened (the request, the offer, completion), then the
// times and the amounts before the buttons, then the progress; the booking, the forms and the salon around it.

import { useCallback, useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { useT } from './i18n.tsx';
import type { AState, Approval, BState, CaseView, Money } from './types.ts';
import { PHOTOS } from './art.ts';
import {
  ActionBar,
  ActionButton,
  Amount,
  ApprovalBox,
  ApprovalChips,
  CaseProgress,
  CHECKING,
  ConditionsSummary,
  Events,
  Icon,
  ImageSlot,
  IntakePanel,
  MoveCards,
  Notice,
  Section,
  ServiceMeta,
  Shell,
  ShopCard,
  splitSpan,
  StatusChip,
  StepChip,
  useAction,
} from './ui.tsx';

const decision = (c: CaseView) => ({ caseId: c.id, version: c.version, termsHash: c.termsHash });

function Terms({ tz }: { tz: string }) {
  const t = useT();
  return (
    <div className="terms">
      <p className="terms-title">{t.termsTitle}</p>
      <ul>
        <li>
          <Icon name="clock" />
          {t.termLocal(tz)}
        </li>
        <li>
          <Icon name="refund" />
          {t.termOnce}
        </li>
        <li>
          <Icon name="scissors" />
          {t.termSame}
        </li>
      </ul>
    </div>
  );
}

export function AScreen({ api, state, refresh }: { api: Api; state: AState; refresh: () => Promise<void> }) {
  const t = useT();
  const act = useAction(refresh);
  const [approval, setApproval] = useState<Approval | null>(null);
  const pay = state.booking.payment;
  const tz = state.header.shop.timeZone;
  const mode = state.header.modes.payment;
  const asked = state.cases.some((c) => c.actions.approve || c.actions.reject);

  // After a reload while A's order waits for approval, get the link again (same order, nothing new is created).
  useEffect(() => {
    if (pay.state === 'WAITING_BUYER' && !approval) void api.post<{ approval: Approval }>('payment/start').then((r) => setApproval(r.approval), () => {});
    if (pay.state === 'PAID') setApproval(null);
  }, [pay.state]);

  const onApproved = useCallback(() => act.run(() => api.post('payment/approved'), 'approved'), [api]);

  return (
    <Shell
      header={state.header}
      roleSeg="a"
      title={asked ? t.pageTitle.aAsk : t.pageTitle.a}
      side={
        <ShopCard header={state.header}>
          <Terms tz={tz} />
        </ShopCard>
      }
    >
      {state.cases.map((c) => (
        <ACase key={c.id} api={api} c={c} refresh={refresh} paid={state.booking.price} refundNote={state.refundNote} />
      ))}

      <Section title={t.yourBooking} aside={<StepChip step={pay.state === 'PAID' ? { state: 'DONE', text: pay.text } : pay} />}>
        <p className="booking-line">{t.bookingLine(state.booking.time, state.booking.service, state.booking.stylist, state.booking.price.text)}</p>
        {pay.state === 'UNPAID' && (
          <>
            <p>{t.payFirst}</p>
            <ActionBar
              pinned={false}
              primary={
                <ActionButton
                  icon="lock"
                  label={mode === 'SANDBOX' ? t.payWithSandbox(state.booking.price.text) : t.payMockButton(state.booking.price.text)}
                  sub={t.payBookingSub[mode]}
                  busy={act.busyKey === 'pay'}
                  disabled={act.busy}
                  onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('payment/start')).approval), 'pay')}
                />
              }
            />
          </>
        )}
        {pay.state === 'WAITING_BUYER' && <ApprovalBox approval={approval} busy={act.busy} onApproved={onApproved} onMock={() => act.run(() => api.post('payment/mock-approve'), 'mock')} />}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </Section>

      <Section title={t.whenMove}>
        {state.preference && <ConditionsSummary c={state.preference} label={t.yourConditions} />}
        <IntakePanel
          api={api}
          role="A"
          header={state.header}
          draft={state.draft}
          blocked={state.intakeBlocked}
          refresh={refresh}
          intro={state.preference ? t.aIntroAgain : t.aIntroNew(state.header.shop.compensation.text)}
        />
      </Section>
    </Shell>
  );
}

function ACase({ api, c, refresh, paid, refundNote }: { api: Api; c: CaseView; refresh: () => Promise<void>; paid: Money; refundNote: string }) {
  const t = useT();
  const act = useAction(refresh);
  const asked = c.actions.approve || c.actions.reject;
  const done = c.status === 'COMPLETED';
  return (
    <>
      {asked && (
        <section className="hero">
          <span className="kicker">
            <Icon name="calendar" />
            {t.aHero.kicker}
          </span>
          <h2>{t.aHero.title}</h2>
          <p>{t.aHero.body(c.origin)}</p>
          <div className="hero-amt">
            <span className="lbl">{t.aHero.refund}</span>
            <Amount m={c.aCompensation} />
          </div>
        </section>
      )}
      {done && (
        <section className="hero ok">
          <span className="kicker">
            <Icon name="check" />
            {t.aDone.kicker}
          </span>
          <h2>{t.aDone.title(c.destination)}</h2>
          <p>{t.aDone.body(c.aCompensation.text)}</p>
        </section>
      )}
      {c.approvals.A === 'APPROVED' && c.status === 'A_ACCEPTED' && (
        <Notice kind="info" title={t.aAgreedTitle}>
          {t.youAgreed}
        </Notice>
      )}
      <section className="card" id="swap">
        <div className="card-head">
          <h2>{t.aChangeTitle}</h2>
          {asked ? (
            <span className="chip wait">
              <Icon name="clock" />
              {t.replyChip(c.offerExpiresAt)}
            </span>
          ) : (
            <StatusChip c={c} />
          )}
        </div>
        <MoveCards from={c.origin} to={c.destination} />
        <ServiceMeta service={t.sameService(c.aService)} stylist={t.sameStylist(c.stylist)} />
        {asked ? (
          <>
            <p className="label">{t.refundTitle}</p>
            <div className="rows">
              <div className="row">
                <span>{t.refundRows.paid}</span>
                <Amount m={paid} />
              </div>
              <div className="row total">
                <span>{t.refundRows.refund}</span>
                <Amount m={c.aCompensation} />
              </div>
              <div className="row">
                <span>{t.refundRows.to}</span>
                <span>{t.refundRows.toValue}</span>
              </div>
              <div className="row">
                <span>{t.refundRows.newCharge}</span>
                <span>{t.refundRows.none}</span>
              </div>
            </div>
            <p className="fine">{refundNote}</p>
            <p className="label">{t.approvalsLabel}</p>
            <ApprovalChips c={c} />
            {c.status === 'AWAITING_APPROVAL' && c.approvals.OWNER !== 'APPROVED' && <p className="fine">{t.shopFirst}</p>}
            <ActionBar
              primary={
                c.actions.approve && (
                  <ActionButton
                    label={t.agreeToMove}
                    sub={t.agreeSub(c.destination)}
                    busy={act.busyKey === 'approve'}
                    disabled={act.busy}
                    onClick={() => void act.run(() => api.post('cases/approve', decision(c)), 'approve')}
                  />
                )
              }
              secondary={
                c.actions.reject && (
                  <ActionButton kind="secondary" label={t.declineKeep} busy={act.busyKey === 'reject'} disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)), 'reject')} />
                )
              }
              note={t.actionNote}
            />
          </>
        ) : (
          <>
            <p className="label">{t.progressTitle}</p>
            <CaseProgress c={c} />
            <div className="rows steps-rows">
              <div className="row">
                <span>{t.yourBookingLabel}</span>
                <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookingsChanged ? t.movedTo(c.destination) : t.notChanged}</span>
              </div>
              <div className="row">
                <span>
                  {t.yourCompensation} <Amount m={c.aCompensation} />
                </span>
                <StepChip step={c.steps.aRefund} />
              </div>
            </div>
            <Events c={c} />
          </>
        )}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </section>
    </>
  );
}

export function BScreen({ api, state, refresh }: { api: Api; state: BState; refresh: () => Promise<void> }) {
  const t = useT();
  const tz = state.header.shop.timeZone;
  return (
    <Shell
      header={state.header}
      roleSeg="b"
      title={t.pageTitle.b}
      side={
        <ShopCard header={state.header}>
          <Terms tz={tz} />
        </ShopCard>
      }
    >
      {state.cases.map((c) => (
        <BCase key={c.id} api={api} c={c} refresh={refresh} tz={tz} mode={state.header.modes.payment} />
      ))}
      <Section title={t.yourRequest}>
        {state.request && <ConditionsSummary c={state.request} label={t.yourConfirmedRequest} />}
        {state.result &&
          !state.cases.some((c) => !['REJECTED', 'EXPIRED', 'COMPENSATED'].includes(c.status)) &&
          (state.result.feasible ? (
            <Notice kind="ok">{t.slotOffered}</Notice>
          ) : (
            <Notice kind="warn" title={t.cannotOffer}>
              <ul>
                {state.result.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </Notice>
          ))}
        <IntakePanel api={api} role="B" header={state.header} draft={state.draft} blocked={state.intakeBlocked} refresh={refresh} intro={t.bIntro} />
      </Section>
    </Shell>
  );
}

function BCase({ api, c, refresh, tz, mode }: { api: Api; c: CaseView; refresh: () => Promise<void>; tz: string; mode: 'SANDBOX' | 'MOCK' }) {
  const t = useT();
  const act = useAction(refresh);
  const [approval, setApproval] = useState<Approval | null>(null);
  const waiting = c.steps.bPayment.state === 'WAITING_BUYER' && c.actions.payPal;
  const open = c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED';
  const done = c.status === 'COMPLETED';
  const [date, time] = splitSpan(c.bSlot);

  useEffect(() => {
    if (waiting && !approval) void api.get<{ approval: Approval }>(`cases/approval-link?caseId=${encodeURIComponent(c.id)}`).then((r) => setApproval(r.approval), () => {});
    if (!waiting) setApproval(null);
  }, [waiting]);

  const onApproved = useCallback(() => act.run(() => api.post('cases/approved', { caseId: c.id }), 'approved'), [api, c.id]);

  return (
    <>
      {open && (
        <section className="hero">
          <span className="kicker">
            <Icon name="calendar" />
            {t.bHero.kicker}
          </span>
          <h2>{t.bHero.title(c.bSlot)}</h2>
          <p>{c.approvals.A === 'APPROVED' ? t.aAgreed : t.aMayMove}</p>
        </section>
      )}
      {done && (
        <section className="hero ok">
          <span className="kicker">
            <Icon name="check" />
            {t.bDone.kicker}
          </span>
          <h2>{t.bDone.title}</h2>
          <p>{t.bDone.body}</p>
        </section>
      )}
      {CHECKING.includes(c.status) && (
        <Notice kind="info" pending title={t.checkingPay.title}>
          {t.checkingPay.body}
        </Notice>
      )}
      <section className={`ticket${done ? ' done' : ''}`} id="swap">
        <div className="ticket-top">
          <div>
            <p className="d">{date}</p>
            <p className="t num">{time}</p>
            <p className="tz">{t.localTime(tz)}</p>
            <ServiceMeta service={c.bService ?? t.serviceFallback} stylist={c.stylist} />
          </div>
          <div className="ticket-thumb">
            <ImageSlot shape="sq" icon="scissors" src={PHOTOS.service} />
          </div>
        </div>
        <div className="ticket-sep" aria-hidden="true" />
        <div className="ticket-bottom">
          <span className="lbl">{t.bTotal}</span>
          <Amount m={c.bPrice} />
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>{open ? t.offerTitle : t.progressTitle}</h2>
          <StatusChip c={c} />
        </div>
        {open && (
          <>
            <p className="label">{t.approvalsLabel}</p>
            <ApprovalChips c={c} />
            <div className="rows">
              <div className="row">
                <span>{t.offerRows.validUntil}</span>
                <span>{c.offerExpiresAt}</span>
              </div>
              <div className="row">
                <span>{t.offerRows.how}</span>
                <span>{t.offerRows[mode]}</span>
              </div>
            </div>
            {c.status === 'AWAITING_APPROVAL' && <p className="fine">{t.waitingShopA}</p>}
          </>
        )}
        {(c.actions.pay || c.actions.reject) && (
          <ActionBar
            primary={
              c.actions.pay && (
                <ActionButton
                  icon="lock"
                  label={t.payLabel(c.bPrice.text)}
                  sub={t.paySub[mode]}
                  busy={act.busyKey === 'pay'}
                  disabled={act.busy}
                  onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('cases/pay', decision(c))).approval), 'pay')}
                />
              )
            }
            secondary={c.actions.reject && <ActionButton kind="secondary" label={t.decline} busy={act.busyKey === 'reject'} disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)), 'reject')} />}
            note={c.actions.pay ? t.termsFrozen : undefined}
          />
        )}
        {waiting && (
          <>
            {c.paymentDeadline && <p className="fine">{t.approveBy(c.paymentDeadline)}</p>}
            <ApprovalBox approval={approval} busy={act.busy} onApproved={onApproved} onMock={() => act.run(() => api.post('cases/mock-approve', { caseId: c.id }), 'mock')} />
          </>
        )}
        {!open && (
          <>
            <CaseProgress c={c} />
            <div className="rows steps-rows">
              <div className="row">
                <span>{t.payment}</span>
                <StepChip step={c.steps.bPayment} />
              </div>
              {c.steps.authorizationRelease && (
                <div className="row">
                  <span>{t.authorization}</span>
                  <StepChip step={c.steps.authorizationRelease} />
                </div>
              )}
              {c.steps.bRefund && (
                <div className="row">
                  <span>{t.refundToYou}</span>
                  <StepChip step={c.steps.bRefund} />
                </div>
              )}
              <div className="row">
                <span>{t.yourBookingLabel}</span>
                <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookingsChanged ? t.confirmedSlot(c.bSlot) : t.notConfirmedYet}</span>
              </div>
            </div>
            <Events c={c} />
          </>
        )}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </section>
    </>
  );
}
