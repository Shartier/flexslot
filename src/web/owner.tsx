// The owner's screen (SPEC 3), design 1 "salon" of the HTML mockup v3: what needs the owner first (a notice), the
// swap proposal (B's slot, A's before and after, the amounts, approvals and the decision), the profit estimate beside
// it, then the money steps and records, bookings, the conditions with the program's verdict, items that need
// attention, AI calls and the history.

import type { Api } from './api.ts';
import { useT } from './i18n.tsx';
import type { OwnerCase, OwnerState } from './types.ts';
import {
  ActionBar,
  ActionButton,
  AmountGrid,
  ApprovalChips,
  CaseProgress,
  CHECKING,
  ConditionsSummary,
  Events,
  MoveCards,
  Notice,
  ProfitCard,
  Section,
  ServiceMeta,
  Shell,
  ShopCard,
  SlotHeading,
  StatusChip,
  StepChip,
  useAction,
} from './ui.tsx';

export function OwnerScreen({ api, state, refresh }: { api: Api; state: OwnerState; refresh: () => Promise<void> }) {
  const t = useT();
  const kind = (k: string) => t.kind[k] ?? k;
  const tz = state.header.shop.timeZone;
  const side = (
    <>
      {state.cases[0] && <ProfitCard profit={state.cases[0].profit} />}
      <ShopCard header={state.header} />
    </>
  );
  return (
    <Shell header={state.header} roleSeg="owner" title={t.pageTitle.owner} side={side}>
      {(state.stopped.length > 0 || state.needsAttentionObligations.length > 0) && (
        <Notice kind="error">{t.stoppedNotice(Math.max(state.stopped.length, state.needsAttentionObligations.length))}</Notice>
      )}
      {state.cases.map((c) => (
        <OwnerCaseCard key={c.id} api={api} c={c} refresh={refresh} tz={tz} />
      ))}

      {(state.stopped.length > 0 || state.needsAttentionObligations.length > 0) && (
        <Section title={t.stoppedTitle} id="status">
          <p className="small">{t.stoppedBody}</p>
          <ul className="history">
            {state.stopped.map((e, i) => (
              <li key={i}>
                {kind(e.obligation)} · {e.operation} ({e.status}) · <span className="mono small">{e.reason}</span>
              </li>
            ))}
            {state.needsAttentionObligations.map((k, i) => (
              <li key={`o${i}`}>{t.needsAttentionItem(kind(k))}</li>
            ))}
          </ul>
        </Section>
      )}
      {state.checking.length > 0 && (
        <Section title={t.checkingTitle}>
          <p className="small">{t.checkingBody}</p>
          <ul className="history">
            {state.checking.map((e, i) => (
              <li key={i}>
                {kind(e.obligation)} · {e.operation} · <span className="mono small">{e.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t.bookings} id="bookings">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t.thCustomer}</th>
                <th>{t.thTime}</th>
                <th>{t.thService}</th>
                <th>{t.thPrice}</th>
                <th>{t.thPayment}</th>
              </tr>
            </thead>
            <tbody>
              {state.bookings.map((b, i) => (
                <tr key={i}>
                  <td>{b.customer}</td>
                  <td>
                    {b.time}
                    {b.version > 1 ? t.moved : ''}
                  </td>
                  <td>{b.service}</td>
                  <td className="num">{b.price.text}</td>
                  <td>{b.payment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">{t.compRule(state.header.shop.compensation.text)}</p>
      </Section>

      <Section title={t.conditions} id="conditions">
        <div className="grid2">
          {state.preference ? <ConditionsSummary c={state.preference} label={t.aCanMoveTo} /> : <p className="muted-text">{t.noPreference}</p>}
          {state.request ? <ConditionsSummary c={state.request} label={t.bCanOnlyCome} /> : <p className="muted-text">{t.noRequest}</p>}
        </div>
        {state.evaluation && (
          <div className="verdict">
            <p>
              {t.programCheck(state.evaluation.at)}
              <span className={`chip ${state.evaluation.feasible ? 'ok' : 'wait'}`}>{state.evaluation.feasible ? t.swapPossible : t.noSwapPossible}</span>
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

      <Section title={t.aiCalls}>
        {state.aiUsage.length === 0 ? (
          <p className="muted-text">{t.noneYet}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t.thKind}</th>
                  <th>{t.thMode}</th>
                  <th>{t.thOutcome}</th>
                  <th>{t.thAttempts}</th>
                  <th>{t.thLatency}</th>
                </tr>
              </thead>
              <tbody>
                {state.aiUsage.map((u, i) => (
                  <tr key={i}>
                    <td>{u.kind === 'A_PREFERENCE' ? t.kindMove : t.kindRequest}</td>
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

      <Section title={t.history} id="history">
        <ul className="history">
          {state.history.map((e, i) => (
            <li key={i}>
              <span className="muted-text">{e.at}</span> <span className="chip muted">{e.actor}</span> {e.action}
            </li>
          ))}
        </ul>
      </Section>
    </Shell>
  );
}

function OwnerCaseCard({ api, c, refresh, tz }: { api: Api; c: OwnerCase; refresh: () => Promise<void>; tz: string }) {
  const t = useT();
  const act = useAction(refresh);
  const decision = { caseId: c.id, version: c.version, termsHash: c.termsHash };
  const open = c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED';
  return (
    <>
      {c.actions.approve && (
        <Notice kind="wait" title={t.ownerAsk.title}>
          {t.ownerAsk.body(c.offerExpiresAt)}
        </Notice>
      )}
      {CHECKING.includes(c.status) && (
        <Notice kind="info" pending title={t.checkingPay.title}>
          {t.ownerChecking}
        </Notice>
      )}
      {c.status === 'COMPLETED' && (
        <Notice kind="ok" title={t.ownerDone.title}>
          {t.ownerDone.body(c.aCompensation.text)}
        </Notice>
      )}
      <section className="card" id="swap">
        <div className="card-head">
          <h2>{t.proposalVersion(c.version)}</h2>
          <StatusChip c={c} />
        </div>
        <SlotHeading label={t.bSlotLabel} span={c.bSlot} tz={tz} />
        <ServiceMeta service={c.bService ?? t.serviceFallback} stylist={c.stylist} />
        <p className="label">{t.ownerAChange}</p>
        <MoveCards from={c.origin} to={c.destination} />
        <p className="label">{t.moneyGlance}</p>
        <AmountGrid
          items={[
            { label: t.amtRevenue, m: c.bPrice, sign: '+' },
            { label: t.amtComp, m: c.aCompensation, sign: '−' },
            { label: t.amtProfit, m: c.profit.additionalProfit, sign: '+', strong: true },
          ]}
        />
        <p className="fine">{t.ownerComp(c.aCompensation.text)}</p>
        <p className="label">{t.approvalsLabel}</p>
        <ApprovalChips c={c} />
        {open && <p className="fine">{t.approvalsDue(c.offerExpiresAt)}</p>}
        {(c.actions.approve || c.actions.reject) && (
          <ActionBar
            primary={
              c.actions.approve && (
                <ActionButton
                  label={t.approveSwap}
                  sub={t.approveSub}
                  busy={act.busyKey === 'approve'}
                  disabled={act.busy}
                  onClick={() => void act.run(() => api.post('cases/approve', decision), 'approve')}
                />
              )
            }
            secondary={
              c.actions.reject && (
                <ActionButton kind="secondary" label={t.ownerDecline} busy={act.busyKey === 'reject'} disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision), 'reject')} />
              )
            }
            note={t.actionNote}
          />
        )}
        {act.error && <Notice kind="error">{act.error}</Notice>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{t.moneyAndBookings}</h2>
        </div>
        <CaseProgress c={c} />
        <div className="rows steps-rows">
          <div className="row">
            <span>{t.bPaymentLabel}</span>
            <StepChip step={c.steps.bPayment} />
          </div>
          {c.steps.authorizationRelease && (
            <div className="row">
              <span>{t.authReleaseLabel}</span>
              <StepChip step={c.steps.authorizationRelease} />
            </div>
          )}
          <div className="row">
            <span>{t.compRefundLabel}</span>
            <StepChip step={c.steps.aRefund} />
          </div>
          {c.steps.bRefund && (
            <div className="row">
              <span>{t.bRefundLabel}</span>
              <StepChip step={c.steps.bRefund} />
            </div>
          )}
          <div className="row">
            <span>{t.bookingsLabel}</span>
            <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookings}</span>
          </div>
        </div>
        {c.obligations.length > 0 && (
          <details>
            <summary>{t.records}</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.thWhat}</th>
                    <th>{t.thAmount}</th>
                    <th>{t.thStatus}</th>
                    <th>{t.thOps}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {c.obligations.map((o) => (
                    <tr key={o.id}>
                      <td>{t.kind[o.kind] ?? o.kind}</td>
                      <td className="num">{o.amount.text}</td>
                      <td>{o.status}</td>
                      <td className="small">
                        {o.attempts.map((tr) =>
                          tr.ops.map((op, j) => (
                            <div key={`${tr.no}-${j}`}>
                              #{tr.no}: {op.kind} {op.status}
                              {op.external ? ` / ${op.external}` : ''}
                              {op.reconcile ? ` (${op.reconcile === 'MATCHED' ? t.reconciled : t.reconciling})` : ''}
                              {op.sends > 1 ? t.sentTimes(op.sends) : ''}
                              {op.error ? ` · ${op.error}` : ''}
                            </div>
                          )),
                        )}
                      </td>
                      <td>
                        {o.retryable && (
                          <button type="button" disabled={act.busy} onClick={() => void act.run(() => api.post('obligations/retry', { obligationId: o.id }), `retry-${o.id}`)}>
                            {act.busyKey === `retry-${o.id}` ? t.working : t.recover}
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
      </section>
    </>
  );
}
