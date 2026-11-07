// Entry of the screens: the landing page (create a demo world), the three role screens, and the PayPal return page.
// The crafted version of the HTML mockup v4 (design/mockup-v4) with the terracotta accent, chosen on 2026-11-07.

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Api, explain } from './api.ts';
import { AScreen, BScreen } from './customer.tsx';
import { loadDemo, saveDemo, type DemoLinks, type RoleSeg } from './demo-links.ts';
import { LangProvider, useLang, useT } from './i18n.tsx';
import { OwnerScreen } from './owner.tsx';
import type { AState, BState, OwnerState } from './types.ts';
import { ActionBar, ActionButton, ActionLink, AppBar, CardHead, Footer, Icon, KICKER, Notice, Photo, type IconName } from './ui.tsx';
import { paypalReturnText } from './paypal-return.ts';
// Bundled fonts (OFL-1.1, @fontsource): headings Shippori Mincho, text Zen Kaku Gothic New, figures Inter, Latin
// captions Cormorant Garamond. Served from this origin (CSP: 'self'); only the subsets a page uses are downloaded.
import '@fontsource/shippori-mincho/700.css';
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import '@fontsource/cormorant-garamond/latin-600-italic.css';
import './styles.css';

/** The three screens of a demo world: open here, or copy a link for another device. */
function DemoLinksCard({ demo, title, created, lift }: { demo: DemoLinks; title: string; created?: boolean; lift?: boolean }) {
  const t = useT();
  const roles: Array<[RoleSeg, string, string]> = [
    ['owner', t.shopBadge, t.roleOwner],
    ['a', 'A', t.roleA],
    ['b', 'B', t.roleB],
  ];
  return (
    <section className={`card${lift ? ' lift' : ''}`}>
      <CardHead k={created ? 'READY' : 'LAST DEMO'} title={title} aside={created ? <span className="chip ok">{t.createdChip}</span> : undefined} />
      {created && <p className="fine">{t.createdBody}</p>}
      <div className="roles">
        {roles.map(([k, badge, label]) => (
          <div className="role" key={k}>
            <p className="rh">
              <span className="av" aria-hidden="true">
                {badge}
              </span>
              {label}
            </p>
            <p className="rb">{t.roleTask[k]}</p>
            <ActionLink kind="secondary" href={demo.links[k]} label={t.openScreen} />
            <input className="mono" readOnly value={demo.links[k]} onFocus={(e) => e.currentTarget.select()} aria-label={t.linkOf(label)} />
          </div>
        ))}
      </div>
      {created && <p className="fine">{t.suggestedOrder}</p>}
    </section>
  );
}

function Option(p: { name: string; checked: boolean; disabled?: boolean; onChange: () => void; icon: IconName; title: string; sub: string }) {
  return (
    <label className={`opt${p.checked ? ' on' : ''}${p.disabled ? ' off' : ''}`}>
      <input type="radio" name={p.name} checked={p.checked} disabled={p.disabled} onChange={p.onChange} />
      <span className="radio" aria-hidden="true" />
      <span className="oi" aria-hidden="true">
        <Icon name={p.icon} />
      </span>
      <span className="opt-text">
        <b>{p.title}</b>
        <small>{p.sub}</small>
      </span>
    </label>
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
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    void fetch('/api/config').then(async (r) => {
      const c = (await r.json()) as NonNullable<typeof config>;
      setConfig(c);
      if (c.ai.vertex) setAiMode('VERTEX');
      if (c.payment.sandbox) setPaymentMode('SANDBOX');
    });
  }, []);
  // One demo per press: a second tap while the first request runs is ignored (phone check, 2026-11-07).
  const create = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aiMode, paymentMode }) });
      if (!r.ok) {
        setError(t.createFailed(((await r.json()) as { error?: string }).error ?? String(r.status)));
        return;
      }
      const w = (await r.json()) as DemoLinks;
      saveDemo({ worldId: w.worldId, links: w.links });
      setWorld(w);
    } catch {
      setError(t.errorUnknown);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const how: IconName[] = ['calendar', 'person', 'check'];
  return (
    <>
      <AppBar k={KICKER.landing} title={t.landingTitle} eyebrow={t.landingEyebrow} />
      <section className="cover">
        <Photo slot="cover" />
        <div className="veil" />
        <div className="cover-in">
          <span className="kicker">
            <Icon name="swap" />
            {t.landingKicker}
          </span>
          <h2 className="display">{t.heroTitle}</h2>
          <p className="lead">{t.heroLead}</p>
          <p className="glass">
            <span>
              <Icon name="store" />
              {t.chipSalon}
            </span>
            <span>
              <Icon name="receipt" />
              {t.chipUsd}
            </span>
            <span>
              <Icon name="lock" />
              {t.chipTest}
            </span>
          </p>
        </div>
      </section>
      <div className="layout single">
        <main className="content">
          {world ? (
            <DemoLinksCard demo={world} title={t.createdTitle} created lift />
          ) : (
            <section className="card lift">
              <CardHead k="START" title={t.createTitle} />
              {!config ? (
                <p>{t.loading}</p>
              ) : (
                <div className="opts">
                  <fieldset className="choice">
                    <legend>{t.aiLegend}</legend>
                    <Option
                      name="ai"
                      icon="info"
                      checked={aiMode === 'VERTEX'}
                      disabled={!config.ai.vertex}
                      onChange={() => setAiMode('VERTEX')}
                      title="Gemini on Vertex AI"
                      sub={config.ai.vertex ? t.optVertexSub(config.ai.vertexModel) : t.notOnServer}
                    />
                    <Option name="ai" icon="sliders" checked={aiMode === 'MOCK'} onChange={() => setAiMode('MOCK')} title={t.optMockAi} sub={t.optMockAiSub} />
                  </fieldset>
                  <fieldset className="choice">
                    <legend>{t.paymentLegend}</legend>
                    <Option
                      name="pay"
                      icon="lock"
                      checked={paymentMode === 'SANDBOX'}
                      disabled={!config.payment.sandbox}
                      onChange={() => setPaymentMode('SANDBOX')}
                      title={t.optSandbox}
                      sub={config.payment.sandbox ? t.optSandboxSub : t.notOnServer}
                    />
                    <Option name="pay" icon="receipt" checked={paymentMode === 'MOCK'} onChange={() => setPaymentMode('MOCK')} title={t.optMockPay} sub={t.optMockPaySub} />
                  </fieldset>
                </div>
              )}
              <ActionBar
                pinned={false}
                primary={<ActionButton icon="swap" label={t.createButton} sub={t.createSub} busy={busy} disabled={!config} onClick={() => void create()} />}
                note={t.modesFixed}
              />
              {error && <Notice kind="error">{error}</Notice>}
            </section>
          )}
          {!world && last && <DemoLinksCard demo={last} title={t.lastDemoTitle} />}

          <section className="card">
            <CardHead k="HOW IT WORKS" title={t.howTitle} />
            <ol className="how">
              {t.how.map(([title, body], i) => (
                <li key={i}>
                  <span className="no" aria-hidden="true">
                    {`0${i + 1}`}
                  </span>
                  <span>
                    <b>
                      <Icon name={how[i] ?? 'check'} /> {title}
                    </b>
                    <span className="how-text">{body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </main>
      </div>
      <Footer />
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
    <div className="layout single">
      <main className="content">
        <section className="card">
          <h1 className="page-h1">{text.title}</h1>
          <p>{text.body}</p>
        </section>
      </main>
    </div>
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
