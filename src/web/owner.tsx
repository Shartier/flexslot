// The owner's screen (SPEC 3): bookings, the conditions and where they came from, the program's verdict with its
// reasons, the proposal with the fixed compensation and the profit estimate, approvals, the money steps, items
// that need attention, and the history.

import type { Api } from './api.ts';
import type { OwnerCase, OwnerState } from './types.ts';
import { ApprovalChips, ConditionsSummary, DemoNote, Events, Notice, Section, StatusChip, StepChip, TopBar, useAction } from './ui.tsx';

const KIND: Record<string, string> = {
  A_ORIGINAL: "Existing customer's booking payment",
  B_CHARGE: "New customer's payment",
  B_AUTH_VOID: 'Release of the authorization',
  A_COMPENSATION_REFUND: 'Compensation refund to the existing customer',
  B_RECOVERY_REFUND: 'Full refund to the new customer',
};

export function OwnerScreen({ api, state, refresh }: { api: Api; state: OwnerState; refresh: () => Promise<void> }) {
  return (
    <>
      <TopBar header={state.header} roleName="Shop owner" />
      <main>
        <DemoNote header={state.header} />
        {(state.stopped.length > 0 || state.needsAttentionObligations.length > 0) && (
          <Notice kind="error">Automatic payment processing stopped for {Math.max(state.stopped.length, state.needsAttentionObligations.length)} item(s). Your action is needed (see “Stopped”).</Notice>
        )}

        <Section title="Bookings">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Time</th>
                  <th>Service</th>
                  <th>Price</th>
                  <th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {state.bookings.map((b, i) => (
                  <tr key={i}>
                    <td>{b.customer}</td>
                    <td>
                      {b.time}
                      {b.version > 1 ? ' (moved)' : ''}
                    </td>
                    <td>{b.service}</td>
                    <td>{b.price.text}</td>
                    <td>{b.payment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted-text">
            Fixed compensation rule: {state.header.shop.compensation.text} per swap, at most once per booking. It is fixed when the customer registers the conditions and does not grow over time.
          </p>
        </Section>

        <Section title="Conditions">
          <div className="grid2">
            {state.preference ? <ConditionsSummary c={state.preference} label="Existing customer can move to" /> : <p className="muted-text">The existing customer has not registered move conditions.</p>}
            {state.request ? <ConditionsSummary c={state.request} label="New customer can only come" /> : <p className="muted-text">No request from a new customer yet.</p>}
          </div>
          {state.evaluation && (
            <div className="verdict">
              <p>
                Program check at {state.evaluation.at}:{' '}
                <span className={`chip ${state.evaluation.feasible ? 'ok' : 'wait'}`}>{state.evaluation.feasible ? 'Swap possible' : 'No swap possible'}</span>
              </p>
              {!state.evaluation.feasible && (
                <ul>
                  {state.evaluation.reasons.map((r) => (
                    <li key={r.code}>
                      {r.text} <span className="mono small muted-text">{r.code}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>

        {state.cases.map((c) => (
          <OwnerCaseCard key={c.id} api={api} c={c} refresh={refresh} />
        ))}

        {(state.stopped.length > 0 || state.needsAttentionObligations.length > 0) && (
          <Section title="Stopped: your action is needed">
            <p className="small">FlexSlot stopped these automatically and does not retry them by itself. Nothing new is charged or refunded until you act. (Releasing a stop is not available in this demo yet.)</p>
            <ul className="history">
              {state.stopped.map((e, i) => (
                <li key={i}>
                  {KIND[e.obligation] ?? e.obligation} · {e.operation} ({e.status}) · <span className="mono small">{e.reason}</span>
                </li>
              ))}
              {state.needsAttentionObligations.map((k, i) => (
                <li key={`o${i}`}>{KIND[k] ?? k}: needs attention (use “Recover” in the payment records if offered)</li>
              ))}
            </ul>
          </Section>
        )}
        {state.checking.length > 0 && (
          <Section title="Still checking with PayPal (a difference was seen)">
            <p className="small">FlexSlot keeps querying PayPal for these and continues once the records match. Nothing moves meanwhile.</p>
            <ul className="history">
              {state.checking.map((e, i) => (
                <li key={i}>
                  {KIND[e.obligation] ?? e.obligation} · {e.operation} · <span className="mono small">{e.reason}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="AI calls in this world">
          {state.aiUsage.length === 0 ? (
            <p className="muted-text">None yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Mode / model</th>
                    <th>Outcome</th>
                    <th>Attempts</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {state.aiUsage.map((u, i) => (
                    <tr key={i}>
                      <td>{u.kind === 'A_PREFERENCE' ? 'Move conditions' : 'Request'}</td>
                      <td>
                        {u.mode} / {u.model}
                      </td>
                      <td>{u.outcome}</td>
                      <td>{u.attempts}</td>
                      <td>{u.latencyMs === null ? '–' : `${u.latencyMs} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="History">
          <ul className="history">
            {state.history.map((e, i) => (
              <li key={i}>
                <span className="muted-text">{e.at}</span> <span className="chip muted">{e.actor}</span> {e.action}
              </li>
            ))}
          </ul>
        </Section>
      </main>
    </>
  );
}

function OwnerCaseCard({ api, c, refresh }: { api: Api; c: OwnerCase; refresh: () => Promise<void> }) {
  const act = useAction(refresh);
  const decision = { caseId: c.id, version: c.version, termsHash: c.termsHash };
  return (
    <Section title={`Swap proposal (version ${c.version})`} aside={<StatusChip c={c} />}>
      <div className="grid2">
        <div>
          <ul className="facts">
            <li>
              Existing customer: <s>{c.origin}</s> → <strong>{c.destination}</strong> (same stylist {c.stylist}, {c.aService})
            </li>
            <li>
              New customer takes <strong>{c.bSlot}</strong> ({c.bService}) for {c.bPrice.text}
            </li>
            <li>Fixed compensation: {c.aCompensation.text} (partial refund of the existing customer's PayPal payment)</li>
            {(c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED') && <li>Approvals due by {c.offerExpiresAt}</li>}
          </ul>
          <ApprovalChips c={c} />
          {(c.actions.approve || c.actions.reject) && (
            <div className="row wrap">
              {c.actions.approve && (
                <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post('cases/approve', decision))}>
                  Approve this swap
                </button>
              )}
              {c.actions.reject && (
                <button disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision))}>
                  Decline
                </button>
              )}
            </div>
          )}
        </div>
        <div>
          <table className="profit">
            <caption>Profit estimate for the shop</caption>
            <tbody>
              {c.profit.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.name}</td>
                  <td className="num">
                    {l.sign < 0 ? '−' : '+'} {l.amount.text}
                  </td>
                </tr>
              ))}
              <tr className="total">
                <td>Additional profit (estimate)</td>
                <td className="num">{c.profit.additionalProfit.text}</td>
              </tr>
            </tbody>
          </table>
          <p className="small muted-text">{c.profit.note}</p>
        </div>
      </div>
      <div className="steps">
        <p>
          New customer's payment: <StepChip step={c.steps.bPayment} />
        </p>
        {c.steps.authorizationRelease && (
          <p>
            Authorization release: <StepChip step={c.steps.authorizationRelease} />
          </p>
        )}
        <p>
          Compensation refund: <StepChip step={c.steps.aRefund} />
        </p>
        {c.steps.bRefund && (
          <p>
            Refund to the new customer: <StepChip step={c.steps.bRefund} />
          </p>
        )}
        <p>Bookings: {c.steps.bookings}</p>
      </div>
      {c.obligations.length > 0 && (
        <details>
          <summary>Payment records (obligations, attempts, PayPal operations)</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Operations (attempt: kind status / PayPal status)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {c.obligations.map((o) => (
                  <tr key={o.id}>
                    <td>{KIND[o.kind] ?? o.kind}</td>
                    <td>{o.amount.text}</td>
                    <td>{o.status}</td>
                    <td className="small">
                      {o.attempts.map((t) =>
                        t.ops.map((op, j) => (
                          <div key={`${t.no}-${j}`}>
                            #{t.no}: {op.kind} {op.status}
                            {op.external ? ` / ${op.external}` : ''}
                            {op.reconcile ? ` (${op.reconcile === 'MATCHED' ? 'reconciled' : 'reconciling'})` : ''}
                            {op.sends > 1 ? ` · sent ${op.sends}×` : ''}
                            {op.error ? ` · ${op.error}` : ''}
                          </div>
                        )),
                      )}
                    </td>
                    <td>
                      {o.retryable && (
                        <button disabled={act.busy} onClick={() => void act.run(() => api.post('obligations/retry', { obligationId: o.id }))}>
                          Recover (same amount)
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <Events c={c} />
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </Section>
  );
}
