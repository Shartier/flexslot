// The existing customer's screen (A) and the new customer's screen (B) (SPEC 3).

import { useCallback, useEffect, useState } from 'react';
import type { Api } from './api.ts';
import type { AState, Approval, BState, CaseView } from './types.ts';
import { ApprovalBox, ConditionsSummary, DemoNote, Events, IntakePanel, Notice, Section, StatusChip, StepChip, TopBar, useAction } from './ui.tsx';

const decision = (c: CaseView) => ({ caseId: c.id, version: c.version, termsHash: c.termsHash });

export function AScreen({ api, state, refresh }: { api: Api; state: AState; refresh: () => Promise<void> }) {
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
      <TopBar header={state.header} roleName="Existing customer (A)" />
      <main>
        <DemoNote header={state.header} />
        <Section title="Your booking" aside={<StepChip step={pay.state === 'PAID' ? { state: 'DONE', text: 'Paid' } : pay} />}>
          <p className="big">
            {state.booking.time} · {state.booking.service} with {state.booking.stylist} · {state.booking.price.text}
          </p>
          {pay.state === 'UNPAID' && (
            <>
              <p>Pay for your booking first. A swap can only be proposed for a paid booking, and the compensation is refunded to this payment.</p>
              <button className="primary" disabled={act.busy} onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('payment/start')).approval))}>
                Pay {state.booking.price.text} {state.header.modes.payment === 'SANDBOX' ? 'with PayPal Sandbox' : '(mock)'}
              </button>
            </>
          )}
          {pay.state === 'WAITING_BUYER' && (
            <ApprovalBox
              approval={approval}
              busy={act.busy}
              who="you"
              onApproved={onApproved}
              onMock={() => act.run(() => api.post('payment/mock-approve'))}
            />
          )}
          {act.error && <Notice kind="error">{act.error}</Notice>}
        </Section>

        <Section title="When could you move? (optional, for a fixed compensation)">
          {state.preference && <ConditionsSummary c={state.preference} label="Your confirmed conditions" />}
          <IntakePanel
            api={api}
            role="A"
            header={state.header}
            draft={state.draft}
            blocked={state.intakeBlocked}
            refresh={refresh}
            intro={
              state.preference
                ? 'To change your conditions, write them again; the new version replaces the old one.'
                : `If someone needs your time, would you move? Tell us when you could come instead. If a swap happens you receive ${state.header.shop.compensation.text}.`
            }
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
  const act = useAction(refresh);
  return (
    <Section title="Swap proposal" aside={<StatusChip c={c} />}>
      <p className="big">
        Move from <s>{c.origin}</s> to <strong>{c.destination}</strong>
      </p>
      <ul className="facts">
        <li>Same stylist ({c.stylist}) and same service ({c.aService}).</li>
        <li>
          Compensation: <strong>{c.aCompensation.text}</strong>, fixed. {refundNote}
        </li>
        {(c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED') && <li>Reply by {c.offerExpiresAt}.</li>}
        {c.status === 'AWAITING_APPROVAL' && c.approvals.OWNER !== 'APPROVED' && <li>The shop reviews the proposal first.</li>}
      </ul>
      {(c.actions.approve || c.actions.reject) && (
        <div className="row wrap">
          {c.actions.approve && (
            <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post('cases/approve', decision(c)))}>
              Agree to move
            </button>
          )}
          {c.actions.reject && (
            <button disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)))}>
              Decline (keep my booking)
            </button>
          )}
        </div>
      )}
      {c.approvals.A === 'APPROVED' && c.status === 'A_ACCEPTED' && <Notice kind="info">You agreed. Waiting for the new customer to pay. Your booking stays as it is until then.</Notice>}
      <div className="steps">
        <p>
          Your booking: <span className="chip muted">{c.steps.bookings.startsWith('Changed') ? `Moved to ${c.destination}` : 'Not changed'}</span>
        </p>
        <p>
          Your compensation: <StepChip step={c.steps.aRefund} />
        </p>
      </div>
      <Events c={c} />
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </Section>
  );
}

export function BScreen({ api, state, refresh }: { api: Api; state: BState; refresh: () => Promise<void> }) {
  return (
    <>
      <TopBar header={state.header} roleName="New customer (B)" />
      <main>
        <DemoNote header={state.header} />
        <Section title="Your request">
          {state.request && <ConditionsSummary c={state.request} label="Your confirmed request" />}
          {state.result && !state.cases.some((c) => !['REJECTED', 'EXPIRED', 'COMPENSATED'].includes(c.status)) && (
            state.result.feasible ? (
              <Notice kind="ok">A slot can be offered. See the offer below.</Notice>
            ) : (
              <Notice kind="warn">
                The requested time cannot be offered right now:
                <ul>
                  {state.result.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </Notice>
            )
          )}
          <IntakePanel
            api={api}
            role="B"
            header={state.header}
            draft={state.draft}
            blocked={state.intakeBlocked}
            refresh={refresh}
            intro="Fully booked when you can come? Tell us the only times that work for you and the service you want."
          />
        </Section>
        {state.cases.map((c) => (
          <BCase key={c.id} api={api} c={c} refresh={refresh} />
        ))}
      </main>
    </>
  );
}

function BCase({ api, c, refresh }: { api: Api; c: CaseView; refresh: () => Promise<void> }) {
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
    <Section title="Your offer" aside={<StatusChip c={c} />}>
      <p className="big">
        {c.bSlot} · {c.bService ?? 'service'} with {c.stylist} · <strong>{c.bPrice.text}</strong>
      </p>
      <ul className="facts">
        <li>
          {c.approvals.A === 'APPROVED'
            ? 'An existing customer agreed to move for a fixed compensation, and the shop approved the swap.'
            : 'An existing customer may move for a fixed compensation; the shop and that customer decide first.'}
        </li>
        {open && <li>Offer valid until {c.offerExpiresAt}.</li>}
        {open && <li>When you start paying, the terms are frozen. This demo does not offer cancellation after that point.</li>}
      </ul>
      {c.status === 'AWAITING_APPROVAL' && <Notice kind="info">Waiting for the shop and the existing customer.</Notice>}
      <div className="row wrap">
        {c.actions.pay && (
          <button
            className="primary"
            disabled={act.busy}
            onClick={() => void act.run(async () => setApproval((await api.post<{ approval: Approval }>('cases/pay', decision(c))).approval))}
          >
            Accept and pay {c.bPrice.text}
          </button>
        )}
        {c.actions.reject && (
          <button disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision(c)))}>
            Decline
          </button>
        )}
      </div>
      {waiting && (
        <>
          {c.paymentDeadline && <p className="small">Please approve on PayPal by {c.paymentDeadline}. Until then nothing is charged.</p>}
          <ApprovalBox approval={approval} busy={act.busy} who="you" onApproved={onApproved} onMock={() => act.run(() => api.post('cases/mock-approve', { caseId: c.id }))} />
        </>
      )}
      {c.status !== 'AWAITING_APPROVAL' && c.status !== 'A_ACCEPTED' && (
        <div className="steps">
          <p>
            Payment: <StepChip step={c.steps.bPayment} />
          </p>
          {c.steps.authorizationRelease && (
            <p>
              Authorization: <StepChip step={c.steps.authorizationRelease} />
            </p>
          )}
          {c.steps.bRefund && (
            <p>
              Refund to you: <StepChip step={c.steps.bRefund} />
            </p>
          )}
          <p>
            Your booking: <span className={`chip ${c.steps.bookings.startsWith('Changed') ? 'ok' : 'muted'}`}>{c.steps.bookings.startsWith('Changed') ? `Confirmed: ${c.bSlot}` : 'Not confirmed yet'}</span>
          </p>
        </div>
      )}
      <Events c={c} />
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </Section>
  );
}
