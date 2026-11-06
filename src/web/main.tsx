// Entry of the screens: the landing page (create a demo world), the three role screens, and the PayPal return page.

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Api, explain } from './api.ts';
import { AScreen, BScreen } from './customer.tsx';
import { loadDemo, saveDemo, type DemoLinks, type RoleSeg } from './demo-links.ts';
import { LangProvider, useLang, useT } from './i18n.tsx';
import { OwnerScreen } from './owner.tsx';
import type { AState, BState, OwnerState } from './types.ts';
import { LangSwitch, Notice } from './ui.tsx';
import { ART } from './art.ts';
import { paypalReturnText } from './paypal-return.ts';
import './styles.css';

function InviteLinks({ demo }: { demo: DemoLinks }) {
  const t = useT();
  const roles: Array<[RoleSeg, string]> = [
    ['owner', t.roleOwner],
    ['a', t.roleA],
    ['b', t.roleB],
  ];
  return (
    <>
      {roles.map(([k, label]) => (
        <div className="invite" key={k}>
          <a className="button" href={demo.links[k]} target="_blank" rel="noopener noreferrer">
            {t.openAs(label)}
          </a>
          <input className="mono" readOnly value={demo.links[k]} onFocus={(e) => e.currentTarget.select()} aria-label={t.linkOf(label)} />
        </div>
      ))}
    </>
  );
}

function Landing() {
  const t = useT();
  const [config, setConfig] = useState<{ ai: { vertex: boolean; vertexModel: string | null }; payment: { sandbox: boolean; mock: boolean } } | null>(null);
  const [aiMode, setAiMode] = useState<'VERTEX' | 'MOCK'>('MOCK');
  const [paymentMode, setPaymentMode] = useState<'SANDBOX' | 'MOCK'>('MOCK');
  const [world, setWorld] = useState<DemoLinks | null>(null);
  const [last] = useState<DemoLinks | null>(loadDemo);
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
      setError(t.createFailed(((await r.json()) as { error?: string }).error ?? String(r.status)));
      return;
    }
    const w = (await r.json()) as DemoLinks;
    saveDemo({ worldId: w.worldId, links: w.links });
    setWorld(w);
  };
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo">FlexSlot</span>
          <span className="role">{t.tagline}</span>
        </div>
        <div className="modes">
          <LangSwitch />
        </div>
      </header>
      <main>
        <section className="card hero">
          <div className="hero-grid">
            <div>
              <h1>{t.heroTitle}</h1>
              <p>{t.heroBody}</p>
              <p className="small muted-text">{t.scope}</p>
            </div>
            <img className="hero-img" src={ART.hero} alt="" aria-hidden="true" width={1600} height={900} />
          </div>
        </section>
        <section className="card">
          <h2>{t.createTitle}</h2>
          {!config ? (
            <p>{t.loading}</p>
          ) : (
            <div className="grid2">
              <fieldset>
                <legend>{t.aiLegend}</legend>
                <label className="radio">
                  <input type="radio" name="ai" checked={aiMode === 'VERTEX'} disabled={!config.ai.vertex} onChange={() => setAiMode('VERTEX')} />
                  Gemini on Vertex AI {config.ai.vertexModel ? `(${config.ai.vertexModel})` : t.notConfigured}
                </label>
                <label className="radio">
                  <input type="radio" name="ai" checked={aiMode === 'MOCK'} onChange={() => setAiMode('MOCK')} />
                  {t.mockAiOption}
                </label>
              </fieldset>
              <fieldset>
                <legend>{t.paymentLegend}</legend>
                <label className="radio">
                  <input type="radio" name="pay" checked={paymentMode === 'SANDBOX'} disabled={!config.payment.sandbox} onChange={() => setPaymentMode('SANDBOX')} />
                  {t.sandboxOption} {config.payment.sandbox ? '' : t.notConfigured}
                </label>
                <label className="radio">
                  <input type="radio" name="pay" checked={paymentMode === 'MOCK'} onChange={() => setPaymentMode('MOCK')} />
                  {t.mockPayOption}
                </label>
              </fieldset>
            </div>
          )}
          <p className="small muted-text">{t.modesFixed}</p>
          <button className="primary" disabled={!config} onClick={() => void create()}>
            {t.createButton}
          </button>
          {error && <Notice kind="error">{error}</Notice>}
        </section>
        {world && (
          <section className="card">
            <h2>{t.linksTitle}</h2>
            <p className="small">{t.linksBody}</p>
            <InviteLinks demo={world} />
            <p className="small muted-text">{t.suggestedOrder}</p>
          </section>
        )}
        {!world && last && (
          <section className="card">
            <h2>{t.lastDemoTitle}</h2>
            <InviteLinks demo={last} />
          </section>
        )}
      </main>
    </>
  );
}

function PayPalReturn({ cancelled }: { cancelled: boolean }) {
  const { lang } = useLang();
  useEffect(() => {
    // Tell the FlexSlot tab of this browser that PayPal sent the buyer back. It only triggers a server-side check.
    if (!cancelled && 'BroadcastChannel' in window) {
      const ch = new BroadcastChannel('flexslot-paypal');
      ch.postMessage({ type: 'approved' });
      ch.close();
    }
  }, []);
  // IA1-02: no claim about the payment here; the FlexSlot screen shows what FlexSlot confirmed with PayPal.
  const text = paypalReturnText(cancelled, lang);
  return (
    <main>
      <section className="card">
        <h1>{text.title}</h1>
        <p>{text.body}</p>
      </section>
    </main>
  );
}

const ROLE_OF: Record<string, 'OWNER' | 'A' | 'B'> = { owner: 'OWNER', a: 'A', b: 'B' };

function RoleApp({ worldId, roleSeg }: { worldId: string; roleSeg: string }) {
  const t = useT();
  const { lang } = useLang();
  const api = useRef(new Api(worldId, roleSeg)).current;
  const [phase, setPhase] = useState<'boot' | 'ok' | 'no-session' | 'error'>('boot');
  const [state, setState] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api.get(`state?lang=${lang}`));
      setErr(null);
    } catch (e) {
      setErr(explain(e, t));
    }
  }, [api, lang]);
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
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, refresh]);

  if (phase === 'boot' || (phase === 'ok' && !state)) return <main className="center">{t.loading}</main>;
  if (phase === 'no-session') {
    return (
      <main>
        <Notice kind="warn">{t.needInvite}</Notice>
      </main>
    );
  }
  if (phase === 'error')
    return (
      <main>
        <Notice kind="error">{t.sessionFailed}</Notice>
      </main>
    );
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
    <LangProvider>
      <App />
    </LangProvider>
  </StrictMode>,
);
