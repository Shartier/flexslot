// The existing customer's screen (A) and the new customer's screen (B) (SPEC 3), the crafted version of mockup v4
// (terracotta): a large card on a photograph that says what is asked or what happened (with a seal on completion),
// then the times and the amounts as a receipt before the buttons, then the progress; the booking, the forms and the
// salon around it.

import { useCallback, useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { useT } from './i18n.tsx';
import type { AState, Approval, BState, CaseView, Money } from './types.ts';
import {
  ActionBar,
  ActionButton,
  Amount,
  ApprovalBox,
  CardHead,
  CaseProgress,
  CHECKING,
  ConditionsSummary,
  Events,
  Icon,
  IntakePanel,
  Ledger,
  MoveCards,
  Notice,
  People,
  Photo,
  PhotoHero,
  Seal,
  Sec,
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
    <ul className="terms">
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

      <Section k="YOUR BOOKING" title={t.yourBooking} aside={<StepChip step={pay.state === 'PAID' ? { state: 'DONE', text: pay.text } : pay} />}>
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

      <Section k="WHEN YOU COULD MOVE" title={t.whenMove}>
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
        <PhotoHero slot="backdrop" icon="calendar" kicker={t.aHero.kicker} title={t.aHero.title}>
          <p>{t.aHero.body(c.origin)}</p>
          <div className="tag-amt">
            <span className="lbl">
              {t.ifYouMove}
              <b>{t.aHero.refund}</b>
            </span>
            <Amount m={c.aCompensation} count />
          </div>
        </PhotoHero>
      )}
      {done && (
        <PhotoHero slot="done" icon="check" kicker={t.aDone.kicker} title={t.aDone.title(c.destination)} done seal="FLEXSLOT · CHANGED · 変更完了 · ">
          <p>{t.aDone.body(c.aCompensation.text)}</p>
        </PhotoHero>
      )}
      {c.approvals.A === 'APPROVED' && c.status === 'A_ACCEPTED' && (
        <Notice kind="info" pending title={t.aAgreedTitle}>
          {t.youAgreed}
        </Notice>
      )}
      <section className="card" id="swap">
        <CardHead
          k="THE CHANGE"
          title={t.aChangeTitle}
          aside={asked ? <span className="chip wait">{t.replyChip(c.offerExpiresAt)}</span> : <StatusChip c={c} />}
        />
        <MoveCards from={c.origin} to={c.destination} />
        <ServiceMeta service={t.sameService(c.aService)} stylist={t.sameStylist(c.stylist)} />
        {asked ? (
          <>
            <Sec no="01">{t.refundTitle}</Sec>
            <Ledger
              rows={[
                { k: t.refundRows.paid, v: <Amount m={paid} /> },
                { k: t.refundRows.to, v: t.refundRows.toValue },
                { k: t.refundRows.newCharge, v: t.refundRows.none },
                { k: t.refundRows.refund, v: <Amount m={c.aCompensation} />, total: true },
              ]}
            />
            <p className="fine">{refundNote}</p>
            <Sec no="02">{t.approvalsLabel}</Sec>
            <People c={c} me="A" />
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
            <Sec no="01">{t.progressTitle}</Sec>
            <CaseProgress c={c} />
            <Ledger
              rows={[
                { k: t.yourBookingLabel, v: <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookingsChanged ? t.movedTo(c.destination) : t.notChanged}</span> },
                {
                  k: (
                    <>
                      {t.yourCompensation} <Amount m={c.aCompensation} />
                    </>
                  ),
                  v: <StepChip step={c.steps.aRefund} />,
                },
              ]}
            />
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
      <Section k="YOUR REQUEST" title={t.yourRequest}>
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
        <PhotoHero slot="backdrop" icon="calendar" kicker={t.bHero.kicker} title={t.bHero.title(c.bSlot)}>
          <p>{c.approvals.A === 'APPROVED' ? t.aAgreed : t.aMayMove}</p>
        </PhotoHero>
      )}
      {done && (
        <PhotoHero slot="done" icon="check" kicker={t.bDone.kicker} title={t.bDone.title} done seal="FLEXSLOT · BOOKED · 予約確定 · ">
          <p>{t.bDone.body}</p>
        </PhotoHero>
      )}
      {CHECKING.includes(c.status) && (
        <Notice kind="info" pending title={t.checkingPay.title}>
          {t.checkingPay.body}
        </Notice>
      )}
      <section className={`ticket${done ? ' done' : ''}`} id="swap">
        <div className="tk-top">
          <div>
            <p className="tk-no">RESERVATION · FS-{c.id.slice(0, 4).toUpperCase()}</p>
            <p className="d">{date}</p>
            <p className="t num">{time}</p>
            <p className="tz">{t.localTime(tz)}</p>
            <ServiceMeta service={c.bService ?? t.serviceFallback} stylist={c.stylist} />
          </div>
          <div className="tk-thumb">
            <Photo slot="service" />
          </div>
        </div>
        <div className="tk-sep" aria-hidden="true" />
        <div className="tk-bottom">
          <span className="lbl">{t.bTotal}</span>
          <Amount m={c.bPrice} />
          {done && <Seal className="tk-stamp" words="PAID · お支払い済み · PAID · " />}
        </div>
      </section>
      <section className="card">
        <CardHead k={open ? 'ACCEPT & PAY' : 'PROGRESS'} title={open ? t.offerTitle : t.progressTitle} aside={<StatusChip c={c} />} />
        {open && (
          <>
            <Sec no="01">{t.approvalsLabel}</Sec>
            <People c={c} me="B" />
            <Sec no="02">{t.termsB}</Sec>
            <Ledger
              rows={[
                { k: t.offerRows.validUntil, v: c.offerExpiresAt },
                { k: t.offerRows.how, v: t.offerRows[mode] },
                { k: t.bTotal, v: <Amount m={c.bPrice} />, total: true },
              ]}
            />
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
            <Ledger
              rows={[
                { k: t.payment, v: <StepChip step={c.steps.bPayment} /> },
                ...(c.steps.authorizationRelease ? [{ k: t.authorization, v: <StepChip step={c.steps.authorizationRelease} /> }] : []),
                ...(c.steps.bRefund ? [{ k: t.refundToYou, v: <StepChip step={c.steps.bRefund} /> }] : []),
                { k: t.yourBookingLabel, v: <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookingsChanged ? t.confirmedSlot(c.bSlot) : t.notConfirmedYet}</span> },
              ]}
            />
            <Events c={c} />
          </>
        )}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </section>
    </>
  );
}
