// The existing customer's screen (A) and the new customer's screen (B) (SPEC 3).

import { useCallback, useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { useT } from './i18n.tsx';
import type { AState, Approval, BState, CaseView } from './types.ts';
import { ApprovalBox, CaseProgress, ConditionsSummary, DemoNote, Events, IntakePanel, Notice, RoleHero, Section, StatusChip, StepChip, TopBar, useAction } from './ui.tsx';

const decision = (c: CaseView) => ({ caseId: c.id, version: c.version, termsHash: c.termsHash });

export function AScreen({ api, state, refresh }: { api: Api; state: AState; refresh: () => Promise<void> }) {
  const t = useT();
  const act = useAction(refresh);
  const [approval, setApproval] = useState<Approval | null>(null);
  const pay = state.booking.payment;

  // After a reload while A's order waits for approval, get the link again (same order, nothing new is created).
  useEffect(() => {
    if (pay.state === 'WAITING_BUYER' && !approval) void api.post<{ approval: Approval }>('payment/start').then((r) => setApproval(r.approval), () => {});
    if (pay.state === 'PAID') setApproval(null);
  }, [pay.state]);

  const onApproved = useCallback(() => act.run(() => api.post('payment/approved')), [api]);

  return (
    <>
      <TopBar header={state.header} roleName={t.roleA} roleSeg="a" />
      <main>
        <RoleHero roleSeg="a" name={t.roleA} />
        <DemoNote header={state.header} />
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

        {state.cases.map((c) => (
          <ACase key={c.id} api={api} c={c} refresh={refresh} refundNote={state.refundNote} />
        ))}
      </main>
    </>
  );
}

function ACase({ api, c, refresh, refundNote }: { api: Api; c: CaseView; refresh: () => Promise<void>; refundNote: string }) {
  const t = useT();
  const act = useAction(refresh);
  return (
    <Section title={t.swapProposal} aside={<StatusChip c={c} />}>
      <CaseProgress c={c} />
      <p className="big">{t.moveFromTo(c.origin, c.destination)}</p>
      <ul className="facts">
        <li>{t.sameStylistService(c.stylist, c.aService)}</li>
        <li>
          {t.compensationFixed(c.aCompensation.text)}
          {refundNote}
        </li>
        {(c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED') && <li>{t.replyBy(c.offerExpiresAt)}</li>}
        {c.status === 'AWAITING_APPROVAL' && c.approvals.OWNER !== 'APPROVED' && <li>{t.shopFirst}</li>}
      </ul>
      {(c.actions.approve || c.actions.reject) && (
        <div className="row wrap">
          {c.actions.approve && (
            <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post('cases/approve', decision(c)))}>
              {t.agreeToMove}
            </button>
          )}
          {c.actions.reject && (
            <button disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)))}>
              {t.declineKeep}
            </button>
          )}
        </div>
      )}
      {c.approvals.A === 'APPROVED' && c.status === 'A_ACCEPTED' && <Notice kind="info">{t.youAgreed}</Notice>}
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
    </Section>
  );
}

export function BScreen({ api, state, refresh }: { api: Api; state: BState; refresh: () => Promise<void> }) {
  const t = useT();
  return (
    <>
      <TopBar header={state.header} roleName={t.roleB} roleSeg="b" />
      <main>
        <RoleHero roleSeg="b" name={t.roleB} />
        <DemoNote header={state.header} />
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
        {state.cases.map((c) => (
          <BCase key={c.id} api={api} c={c} refresh={refresh} />
        ))}
      </main>
    </>
  );
}

function BCase({ api, c, refresh }: { api: Api; c: CaseView; refresh: () => Promise<void> }) {
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
    <Section title={t.yourOffer} aside={<StatusChip c={c} />}>
      <CaseProgress c={c} />
      <p className="big">
        {t.bookingLine(c.bSlot, c.bService ?? t.serviceFallback, c.stylist, '')}
        <strong>{c.bPrice.text}</strong>
      </p>
      <ul className="facts">
        <li>{c.approvals.A === 'APPROVED' ? t.aAgreed : t.aMayMove}</li>
        {open && <li>{t.validUntil(c.offerExpiresAt)}</li>}
        {open && <li>{t.termsFrozen}</li>}
      </ul>
      {c.status === 'AWAITING_APPROVAL' && <Notice kind="info">{t.waitingShopA}</Notice>}
      <div className="row wrap">
        {c.actions.pay && (
          <button className="primary" disabled={act.busy} onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('cases/pay', decision(c))).approval))}>
            {t.acceptAndPay(c.bPrice.text)}
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
          {c.paymentDeadline && <p className="small">{t.approveBy(c.paymentDeadline)}</p>}
          <ApprovalBox approval={approval} busy={act.busy} onApproved={onApproved} onMock={() => act.run(() => api.post('cases/mock-approve', { caseId: c.id }))} />
        </>
      )}
      {c.status !== 'AWAITING_APPROVAL' && c.status !== 'A_ACCEPTED' && (
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
      )}
      <Events c={c} />
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </Section>
  );
}
