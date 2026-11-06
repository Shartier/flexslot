// The owner's screen (SPEC 3), in design v2 (Codex, 2026-11-07): the swap proposal first (B's slot, A's before and
// after, the amounts, approvals, the decision), the profit estimate beside it, then the progress and the money steps,
// bookings, the conditions with the program's verdict, items that need attention, AI calls and the history.

import type { Api } from './api.ts';
import { useT } from './i18n.tsx';
import type { OwnerCase, OwnerState } from './types.ts';
import {
  AmountGrid,
  ApprovalChips,
  CaseProgress,
  ConditionsSummary,
  DemoNote,
  Events,
  Icon,
  MoveCards,
  Notice,
  PageHeading,
  ProfitCard,
  Section,
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
  return (
    <Shell header={state.header} roleName={t.roleOwner} roleSeg="owner">
      <PageHeading eyebrow={state.header.shop.name} title={t.pageTitle.owner} lead={t.pageLead.owner} />
      <DemoNote header={state.header} />
      {(state.stopped.length > 0 || state.needsAttentionObligations.length > 0) && (
        <Notice kind="error">{t.stoppedNotice(Math.max(state.stopped.length, state.needsAttentionObligations.length))}</Notice>
      )}
      <div className="main-grid">
        <div className="col">
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
            <p className="small muted-text">{t.compRule(state.header.shop.compensation.text)}</p>
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
        </div>
        <aside className="right-col">
          {state.cases[0] && <ProfitCard profit={state.cases[0].profit} />}
          <ShopCard header={state.header} />
        </aside>
      </div>
    </Shell>
  );
}

function OwnerCaseCard({ api, c, refresh, tz }: { api: Api; c: OwnerCase; refresh: () => Promise<void>; tz: string }) {
  const t = useT();
  const act = useAction(refresh);
  const decision = { caseId: c.id, version: c.version, termsHash: c.termsHash };
  return (
    <section className="panel case-panel" id="swap">
      <div className="panel-pad">
        <div className="panel-head">
          <p className="case-no">{t.proposalVersion(c.version)}</p>
          <StatusChip c={c} />
        </div>
        <SlotHeading label={t.bSlotLabel} span={c.bSlot} tz={tz} />
        <p className="service-line">
          <Icon name="scissors" />
          {c.bService ?? t.serviceFallback}
          <Icon name="person" />
          {c.stylist}
        </p>
        <MoveCards from={c.origin} to={c.destination} />
        <p className="small muted-text">{t.sameNote}</p>
        <AmountGrid
          items={[
            { label: t.amtRevenue, m: c.bPrice },
            { label: t.amtComp, m: c.aCompensation },
            { label: t.amtProfit, m: c.profit.additionalProfit, sign: '+', strong: true },
          ]}
        />
        <p className="small muted-text">{t.ownerComp(c.aCompensation.text)}</p>
        <ApprovalChips c={c} />
        {(c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED') && <p className="small muted-text">{t.approvalsDue(c.offerExpiresAt)}</p>}
      </div>
      {(c.actions.approve || c.actions.reject) && (
        <div className="panel-bottom">
          <div className="actions">
            {c.actions.approve && (
              <button className="primary" disabled={act.busy} onClick={() => void act.run(() => api.post('cases/approve', decision))}>
                {t.approveSwap}
                <Icon name="arrow" />
              </button>
            )}
            {c.actions.reject && (
              <button className="link" disabled={act.busy} onClick={() => void act.run(() => api.post('cases/reject', decision))}>
                {t.ownerDecline}
              </button>
            )}
          </div>
          <p className="action-note">{t.actionNote}</p>
        </div>
      )}
      <div className="panel-pad progress-pad">
        <h3>{t.progressTitle}</h3>
        <CaseProgress c={c} />
        <div className="steps">
          <p>
            {t.bPaymentLabel} <StepChip step={c.steps.bPayment} />
          </p>
          {c.steps.authorizationRelease && (
            <p>
              {t.authReleaseLabel} <StepChip step={c.steps.authorizationRelease} />
            </p>
          )}
          <p>
            {t.compRefundLabel} <StepChip step={c.steps.aRefund} />
          </p>
          {c.steps.bRefund && (
            <p>
              {t.bRefundLabel} <StepChip step={c.steps.bRefund} />
            </p>
          )}
          <p>
            {t.bookingsLabel} <span className={`chip ${c.steps.bookingsChanged ? 'ok' : 'muted'}`}>{c.steps.bookings}</span>
          </p>
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
                          <button disabled={act.busy} onClick={() => void act.run(() => api.post('obligations/retry', { obligationId: o.id }))}>
                            {t.recover}
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
      </div>
    </section>
  );
}
