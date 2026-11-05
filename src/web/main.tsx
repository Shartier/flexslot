// Entry of the screens: the landing page (create a demo world), the three role screens, and the PayPal return page.

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Api, explain } from './api.ts';
import { AScreen, BScreen } from './customer.tsx';
import { OwnerScreen } from './owner.tsx';
import type { AState, BState, OwnerState } from './types.ts';
import { Notice } from './ui.tsx';
import { paypalReturnText } from './paypal-return.ts';
import './styles.css';

function Landing() {
  const [config, setConfig] = useState<{ ai: { vertex: boolean; vertexModel: string | null }; payment: { sandbox: boolean; mock: boolean } } | null>(null);
  const [aiMode, setAiMode] = useState<'VERTEX' | 'MOCK'>('MOCK');
  const [paymentMode, setPaymentMode] = useState<'SANDBOX' | 'MOCK'>('MOCK');
  const [world, setWorld] = useState<{ worldId: string; links: Record<'owner' | 'a' | 'b', string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/config').then(async (r) => {
      const c = (await r.json()) as NonNullable<typeof config>;
      setConfig(c);
      if (c.ai.vertex) setAiMode('VERTEX');
      if (c.payment.sandbox) setPaymentMode('SANDBOX');
    });
  }, []);
  const create = async () => {
    setError(null);
    const r = await fetch('/api/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aiMode, paymentMode }) });
    if (!r.ok) {
      setError(`Could not create the demo world (${((await r.json()) as { error?: string }).error ?? r.status}).`);
      return;
    }
    setWorld((await r.json()) as NonNullable<typeof world>);
  };
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo">FlexSlot</span>
          <span className="role">compensated booking swaps</span>
        </div>
      </header>
      <main>
        <section className="card">
          <h1>A fully booked slot, one swap, everyone better off</h1>
          <p>
            A new customer (B) can only come at a time that is already booked. An existing customer (A) said in advance when they could move instead. FlexSlot proposes the swap; the shop
            and A approve; B pays with PayPal; A&apos;s booking moves and A receives a fixed compensation as a partial refund of their own payment.
          </p>
          <p className="small muted-text">
            One fictional salon, one stylist, two services, one swap. PayPal Sandbox only: test money, never real payments.
          </p>
        </section>
        <section className="card">
          <h2>Create a demo world</h2>
          {!config ? (
            <p>Loading…</p>
          ) : (
            <div className="grid2">
              <fieldset>
                <legend>AI for free text</legend>
                <label className="radio">
                  <input type="radio" name="ai" checked={aiMode === 'VERTEX'} disabled={!config.ai.vertex} onChange={() => setAiMode('VERTEX')} />
                  Gemini on Vertex AI {config.ai.vertexModel ? `(${config.ai.vertexModel})` : '(not configured on this server)'}
                </label>
                <label className="radio">
                  <input type="radio" name="ai" checked={aiMode === 'MOCK'} onChange={() => setAiMode('MOCK')} />
                  Mock rules (offline, not a real AI)
                </label>
              </fieldset>
              <fieldset>
                <legend>Payment</legend>
                <label className="radio">
                  <input type="radio" name="pay" checked={paymentMode === 'SANDBOX'} disabled={!config.payment.sandbox} onChange={() => setPaymentMode('SANDBOX')} />
                  PayPal Sandbox {config.payment.sandbox ? '' : '(not configured on this server)'}
                </label>
                <label className="radio">
                  <input type="radio" name="pay" checked={paymentMode === 'MOCK'} onChange={() => setPaymentMode('MOCK')} />
                  Mock (no PayPal at all)
                </label>
              </fieldset>
            </div>
          )}
          <p className="small muted-text">The modes are fixed for the world and shown on every screen.</p>
          <button className="primary" disabled={!config} onClick={() => void create()}>
            Create demo world
          </button>
          {error && <Notice kind="error">{error}</Notice>}
        </section>
        {world && (
          <section className="card">
            <h2>Your three invite links</h2>
            <p className="small">
              Each link signs in one role in this world. Keep them private. In real use each person would receive only their own link. Open them in separate tabs (or devices).
            </p>
            {(
              [
                ['owner', 'Shop owner'],
                ['a', 'Existing customer (A)'],
                ['b', 'New customer (B)'],
              ] as const
            ).map(([k, label]) => (
              <div className="invite" key={k}>
                <a className="button" href={world.links[k]} target="_blank" rel="noopener noreferrer">
                  Open as {label}
                </a>
                <input className="mono" readOnly value={world.links[k]} onFocus={(e) => e.currentTarget.select()} aria-label={`${label} link`} />
              </div>
            ))}
            <p className="small muted-text">Suggested order: A pays the booking and registers move conditions → B writes a request → the shop approves → A agrees → B pays.</p>
          </section>
        )}
      </main>
    </>
  );
}

function PayPalReturn({ cancelled }: { cancelled: boolean }) {
  useEffect(() => {
    // Tell the FlexSlot tab of this browser that PayPal sent the buyer back. It only triggers a server-side check.
    if (!cancelled && 'BroadcastChannel' in window) {
      const ch = new BroadcastChannel('flexslot-paypal');
      ch.postMessage({ type: 'approved' });
      ch.close();
    }
  }, []);
  // IA1-02: no claim about the payment here; the FlexSlot screen shows what FlexSlot confirmed with PayPal.
  const t = paypalReturnText(cancelled);
  return (
    <main>
      <section className="card">
        <h1>{t.title}</h1>
        <p>{t.body}</p>
      </section>
    </main>
  );
}

const ROLE_OF: Record<string, 'OWNER' | 'A' | 'B'> = { owner: 'OWNER', a: 'A', b: 'B' };

function RoleApp({ worldId, roleSeg }: { worldId: string; roleSeg: string }) {
  const api = useRef(new Api(worldId, roleSeg)).current;
  const [phase, setPhase] = useState<'boot' | 'ok' | 'no-session' | 'error'>('boot');
  const [state, setState] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api.get('state'));
      setErr(null);
    } catch (e) {
      setErr(explain(e));
    }
  }, [api]);
  useEffect(() => {
    void api.boot().then(
      async (r) => {
        setPhase(r);
        if (r === 'ok') await refresh();
      },
      () => setPhase('error'),
    );
  }, []);
  useEffect(() => {
    if (phase !== 'ok') return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [phase]);

  if (phase === 'boot' || (phase === 'ok' && !state)) return <main className="center">Loading…</main>;
  if (phase === 'no-session') {
    return (
      <main>
        <Notice kind="warn">This screen needs your invite link. Please open the link you received (it signs you in and is then removed from the address bar).</Notice>
      </main>
    );
  }
  if (phase === 'error') return <main><Notice kind="error">Could not start the session. Please reload.</Notice></main>;
  const role = ROLE_OF[roleSeg];
  return (
    <>
      {err && <div className="toast">{err}</div>}
      {role === 'OWNER' ? (
        <OwnerScreen api={api} state={state as OwnerState} refresh={refresh} />
      ) : role === 'A' ? (
        <AScreen api={api} state={state as AState} refresh={refresh} />
      ) : (
        <BScreen api={api} state={state as BState} refresh={refresh} />
      )}
    </>
  );
}

function App() {
  const path = window.location.pathname;
  const m = /^\/w\/([A-Za-z0-9_-]+)\/(owner|a|b)\/?$/.exec(path);
  if (m) return <RoleApp worldId={m[1]!} roleSeg={m[2]!} />;
  if (path === '/paypal/return') return <PayPalReturn cancelled={false} />;
  if (path === '/paypal/cancel') return <PayPalReturn cancelled />;
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
