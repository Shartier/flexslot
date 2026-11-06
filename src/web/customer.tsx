// The existing customer's screen (A) and the new customer's screen (B) (SPEC 3), in design v2 (Codex, 2026-11-07):
// the decision first (times, amount, buttons), then the progress; the forms and the shop's terms around it.

import { useCallback, useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { useT } from './i18n.tsx';
import type { AState, Approval, BState, CaseView } from './types.ts';
import {
  Amount,
  ApprovalBox,
  ApprovalChips,
  CaseProgress,
  ConditionsSummary,
  DemoNote,
  Events,
  Icon,
  IntakePanel,
  MoveCards,
  Notice,
  PageHeading,
  Section,
  Shell,
  ShopCard,
  SlotHeading,
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
      <p>
        <Icon name="clock" />
        {t.termLocal(tz)}
      </p>
      <p>
        <Icon name="refund" />
        {t.termOnce}
      </p>
    </div>
  );
}

export function AScreen({ api, state, refresh }: { api: Api; state: AState; refresh: () => Promise<void> }) {
  const t = useT();
  const act = useAction(refresh);
  const [approval, setApproval] = useState<Approval | null>(null);
  const pay = state.booking.payment;
  const tz = state.header.shop.timeZone;
  const current = state.cases[0];

  // After a reload while A's order waits for approval, get the link again (same order, nothing new is created).
  useEffect(() => {
    if (pay.state === 'WAITING_BUYER' && !approval) void api.post<{ approval: Approval }>('payment/start').then((r) => setApproval(r.approval), () => {});
    if (pay.state === 'PAID') setApproval(null);
  }, [pay.state]);

  const onApproved = useCallback(() => act.run(() => api.post('payment/approved')), [api]);

  return (
    <Shell header={state.header} roleName={t.roleA} roleSeg="a">
      <PageHeading eyebrow={t.eyebrowCustomer(state.header.shop.name)} title={t.pageTitle.a} lead={t.pageLead.a} />
      <DemoNote header={state.header} />
      <div className="main-grid">
        <div className="col">
          {state.cases.map((c) => (
            <ACase key={c.id} api={api} c={c} refresh={refresh} refundNote={state.refundNote} />
          ))}

          <Section title={t.yourBooking} aside={<StepChip step={pay.state === 'PAID' ? { state: 'DONE', text: pay.text } : pay} />}>
            <p className="big">{t.bookingLine(state.booking.time, state.booking.service, state.booking.stylist, state.booking.price.text)}</p>
            {pay.state === 'UNPAID' && (
              <>
                <p>{t.payFirst}</p>
                <button className="primary" disabled={act.busy} onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('payment/start')).approval))}>
                  {state.header.modes.payment === 'SANDBOX' ? t.payWithSandbox(state.booking.price.text) : t.payMockButton(state.booking.price.text)}
                </button>
              </>
            )}
            {pay.state === 'WAITING_BUYER' && <ApprovalBox approval={approval} busy={act.busy} onApproved={onApproved} onMock={() => act.run(() => api.post('payment/mock-approve'))} />}
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
        </div>
        <aside className="right-col">
          {current && (
            <section className="panel quiet-panel refund-card">
              <p className="small muted-text">{t.refundCardTitle}</p>
              <p className="big-amount">
                <Amount m={current.aCompensation} />
              </p>
              <p className="small">{t.refundCardBody(state.booking.price.text)}</p>
              <p className="small muted-text">{t.refundCardNote}</p>
            </section>
          )}
          <ShopCard header={state.header}>
            <Terms tz={tz} />
          </ShopCard>
        </aside>
      </div>
    </Shell>
  );
}

function ACase({ api, c, refresh, refundNote }: { api: Api; c: CaseView; refresh: () => Promise<void>; refundNote: string }) {
  const t = useT();
  const act = useAction(refresh);
  return (
    <section className="panel case-panel" id="swap">
      <div className="panel-pad">
        <div className="panel-head">
          <p className="case-no">{t.swapProposal}</p>
          <StatusChip c={c} />
        </div>
        <h2 className="case-title">{t.aHeadline}</h2>
        <p className="muted-text">{t.aSub(c.aCompensation.text)}</p>
        <MoveCards from={c.origin} to={c.destination} />
        <p className="small muted-text">{t.sameStylistService(c.stylist, c.aService)}</p>
        <div className="total-row">
          <div>
            <p className="total-label">{t.refundLabel}</p>
            <p className="small muted-text">{t.refundSub}</p>
          </div>
          <Amount m={c.aCompensation} />
        </div>
        <p className="small muted-text">{refundNote}</p>
        <ApprovalChips c={c} />
        <ul className="facts small">
          {(c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED') && <li>{t.replyBy(c.offerExpiresAt)}</li>}
          {c.status === 'AWAITING_APPROVAL' && c.approvals.OWNER !== 'APPROVED' && <li>{t.shopFirst}</li>}
        </ul>
      </div>
      {(c.actions.approve || c.actions.reject) && (
        <div className="panel-bottom">
          <div className="actions">
            {c.actions.approve && (
              <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post('cases/approve', decision(c)))}>
                {t.agreeToMove}
                <Icon name="arrow" />
              </button>
            )}
            {c.actions.reject && (
              <button disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)))}>
                {t.declineKeep}
              </button>
            )}
          </div>
          <p className="action-note">{t.actionNote}</p>
        </div>
      )}
      <div className="panel-pad progress-pad">
        {c.approvals.A === 'APPROVED' && c.status === 'A_ACCEPTED' && <Notice kind="info">{t.youAgreed}</Notice>}
        <h3>{t.progressTitle}</h3>
        <CaseProgress c={c} />
        <div className="steps">
          <p>
            {t.yourBookingLabel} <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookingsChanged ? t.movedTo(c.destination) : t.notChanged}</span>
          </p>
          <p>
            {t.yourCompensation} <StepChip step={c.steps.aRefund} />
          </p>
        </div>
        <Events c={c} />
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </div>
    </section>
  );
}

export function BScreen({ api, state, refresh }: { api: Api; state: BState; refresh: () => Promise<void> }) {
  const t = useT();
  const tz = state.header.shop.timeZone;
  return (
    <Shell header={state.header} roleName={t.roleB} roleSeg="b">
      <PageHeading eyebrow={t.eyebrowCustomer(state.header.shop.name)} title={t.pageTitle.b} lead={t.pageLead.b} />
      <DemoNote header={state.header} />
      <div className="main-grid">
        <div className="col">
          {state.cases.map((c) => (
            <BCase key={c.id} api={api} c={c} refresh={refresh} tz={tz} />
          ))}
          <Section title={t.yourRequest}>
            {state.request && <ConditionsSummary c={state.request} label={t.yourConfirmedRequest} />}
            {state.result && !state.cases.some((c) => !['REJECTED', 'EXPIRED', 'COMPENSATED'].includes(c.status)) && (
              state.result.feasible ? (
                <Notice kind="ok">{t.slotOffered}</Notice>
              ) : (
                <Notice kind="warn">
                  {t.cannotOffer}
                  <ul>
                    {state.result.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </Notice>
              )
            )}
            <IntakePanel api={api} role="B" header={state.header} draft={state.draft} blocked={state.intakeBlocked} refresh={refresh} intro={t.bIntro} />
          </Section>
        </div>
        <aside className="right-col">
          <ShopCard header={state.header}>
            <Terms tz={tz} />
          </ShopCard>
        </aside>
      </div>
    </Shell>
  );
}

function BCase({ api, c, refresh, tz }: { api: Api; c: CaseView; refresh: () => Promise<void>; tz: string }) {
  const t = useT();
  const act = useAction(refresh);
  const [approval, setApproval] = useState<Approval | null>(null);
  const waiting = c.steps.bPayment.state === 'WAITING_BUYER' && c.actions.payPal;
  const open = c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED';

  useEffect(() => {
    if (waiting && !approval) void api.get<{ approval: Approval }>(`cases/approval-link?caseId=${encodeURIComponent(c.id)}`).then((r) => setApproval(r.approval), () => {});
    if (!waiting) setApproval(null);
  }, [waiting]);

  const onApproved = useCallback(() => act.run(() => api.post('cases/approved', { caseId: c.id })), [api, c.id]);

  return (
    <section className="panel case-panel" id="swap">
      <div className="panel-pad">
        <div className="panel-head">
          <p className="case-no">{t.yourOffer}</p>
          <StatusChip c={c} />
        </div>
        <SlotHeading label={t.bSlotOwn} span={c.bSlot} tz={tz} />
        <p className="service-line">
          <Icon name="scissors" />
          {c.bService ?? t.serviceFallback}
          <Icon name="person" />
          {c.stylist}
        </p>
        <ul className="facts small">
          <li>{c.approvals.A === 'APPROVED' ? t.aAgreed : t.aMayMove}</li>
          {open && <li>{t.validUntil(c.offerExpiresAt)}</li>}
          {open && <li>{t.termsFrozen}</li>}
        </ul>
        <div className="total-row">
          <p className="total-label">{t.bTotal}</p>
          <Amount m={c.bPrice} />
        </div>
        {c.status === 'AWAITING_APPROVAL' && <Notice kind="info">{t.waitingShopA}</Notice>}
      </div>
      {(c.actions.pay || c.actions.reject || waiting) && (
        <div className="panel-bottom">
          <div className="actions">
            {c.actions.pay && (
              <button className="primary" disabled={act.busy} onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('cases/pay', decision(c))).approval))}>
                {t.acceptAndPay(c.bPrice.text)}
                <Icon name="arrow" />
              </button>
            )}
            {c.actions.reject && (
              <button disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)))}>
                {t.decline}
              </button>
            )}
          </div>
          {waiting && (
            <>
              {c.paymentDeadline && <p className="action-note">{t.approveBy(c.paymentDeadline)}</p>}
              <ApprovalBox approval={approval} busy={act.busy} onApproved={onApproved} onMock={() => act.run(() => api.post('cases/mock-approve', { caseId: c.id }))} />
            </>
          )}
          {!waiting && <p className="action-note">{t.actionNote}</p>}
        </div>
      )}
      {c.status !== 'AWAITING_APPROVAL' && c.status !== 'A_ACCEPTED' && (
        <div className="panel-pad progress-pad">
          <h3>{t.progressTitle}</h3>
          <CaseProgress c={c} />
          <div className="steps">
            <p>
              {t.payment} <StepChip step={c.steps.bPayment} />
            </p>
            {c.steps.authorizationRelease && (
              <p>
                {t.authorization} <StepChip step={c.steps.authorizationRelease} />
              </p>
            )}
            {c.steps.bRefund && (
              <p>
                {t.refundToYou} <StepChip step={c.steps.bRefund} />
              </p>
            )}
            <p>
              {t.yourBookingLabel} <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookingsChanged ? t.confirmedSlot(c.bSlot) : t.notConfirmedYet}</span>
            </p>
          </div>
          <Events c={c} />
        </div>
      )}
      {act.error && (
        <div className="panel-pad">
          <Notice kind="error">{act.error}</Notice>
        </div>
      )}
    </section>
  );
}
