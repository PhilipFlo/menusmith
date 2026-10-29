import { useEffect, useState } from 'react';
import { api, type Health } from './api.ts';
import { Wordmark } from './components/Logo.tsx';
import { Empty } from './components/ui.tsx';
import { useFleetController, useForgeController } from './controllers.ts';
import { AboutPage } from './pages/AboutPage.tsx';
import { ExtractorPage } from './pages/ExtractorPage.tsx';
import { FleetPage } from './pages/FleetPage.tsx';
import { DiscoverPage, useAreaController } from './pages/DiscoverPage.tsx';
import { ForgePage } from './pages/ForgePage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { href, useRoute, type Route } from './router.ts';

const NAV: { page: Route['page']; label: string; href: string }[] = [
  { page: 'forge', label: 'Live Forge', href: href.forge },
  { page: 'discover', label: 'Discover', href: href.discover },
  { page: 'library', label: 'Library', href: href.library },
  { page: 'fleet', label: 'Fleet', href: href.fleet },
  { page: 'about', label: 'How it works', href: href.about },
];

const TITLES: Record<Route['page'], string> = {
  forge: 'Live Forge',
  discover: 'Discover',
  library: 'Library',
  extractor: 'Extractor',
  fleet: 'Fleet',
  about: 'How it works',
  notfound: 'Not found',
};

export function App() {
  const route = useRoute();
  const forge = useForgeController();
  const fleet = useFleetController();
  const area = useAreaController();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .health()
        .then((h) => {
          if (!alive) return;
          setHealth(h);
          setHealthError(false);
        })
        .catch(() => alive && setHealthError(true));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    document.title = `${TITLES[route.page]} · Menusmith`;
  }, [route.page]);

  const activeNav = route.page === 'extractor' ? 'library' : route.page;
  const noKey = health && !health.nebius && health.llmMode === 'live';

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-inner">
          <a href={href.forge} className="brand" aria-label="Menusmith home">
            <Wordmark />
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.page} href={n.href} className={`nav-link ${activeNav === n.page ? 'is-active' : ''}`} aria-current={activeNav === n.page ? 'page' : undefined}>
                {n.label}
                {n.page === 'forge' && forge.state.phase === 'running' && <span className="nav-dot" aria-label="(running)" />}
                {n.page === 'discover' && area.forging && <span className="nav-dot" aria-label="(running)" />}
                {n.page === 'fleet' && fleet.running && <span className="nav-dot" aria-label="(running)" />}
              </a>
            ))}
          </nav>
          <HealthPill health={health} error={healthError} />
        </div>
      </header>

      {noKey && (
        <div className="banner" role="status">
          <div className="container banner-inner">
            <strong>Running without a Token Factory key</strong> — add <code>NEBIUS_API_KEY</code> to <code>.env</code> and restart the server to let the agent forge new extractors. The library and fleet still work: re-runs never call a model.
          </div>
        </div>
      )}
      {healthError && !health && (
        <div className="banner banner-fail" role="alert">
          <div className="container banner-inner">
            <strong>Can't reach the Menusmith API.</strong> Start it with <code>npm start</code> (port 8790).
          </div>
        </div>
      )}

      <main id="main" className="container main" tabIndex={-1}>
        {route.page === 'forge' && <ForgePage forge={forge} health={health} />}
        {route.page === 'discover' && <DiscoverPage ctl={area} />}
        {route.page === 'library' && <LibraryPage />}
        {route.page === 'extractor' && route.id && <ExtractorPage id={route.id} />}
        {route.page === 'fleet' && <FleetPage fleet={fleet} />}
        {route.page === 'about' && <AboutPage health={health} />}
        {route.page === 'notfound' && (
          <Empty title="Nothing here">
            <a className="btn btn-primary" href={href.forge}>
              Go to the Live Forge
            </a>
          </Empty>
        )}
      </main>

      <footer className="site-footer">
        <div className="container footer-inner">
          <span>
            <strong>Menusmith</strong> — agents that write the scraper once, so the price index runs forever.
          </span>
          <span className="muted">NVIDIA Nemotron on Nebius Token Factory · Tavily · Nebius × NVIDIA Global AI Hackathon</span>
        </div>
      </footer>
    </div>
  );
}

function HealthPill({ health, error }: { health: Health | null; error: boolean }) {
  if (error && !health)
    return (
      <span className="health health-fail" title="API unreachable">
        <span className="health-dot" /> Offline
      </span>
    );
  if (!health)
    return (
      <span className="health">
        <span className="health-dot" /> Connecting…
      </span>
    );
  const mode = health.llmMode === 'live' ? 'Live' : health.llmMode === 'replay' ? 'Replay' : health.llmMode === 'record' ? 'Recording' : health.llmMode;
  const ready = health.llmMode !== 'live' || health.nebius;
  const title = `LLM mode: ${health.llmMode}. Nebius Token Factory key: ${health.nebius ? 'present' : 'missing'}. Tavily key: ${health.tavily ? 'present' : 'missing'}.`;
  return (
    <span className={`health ${ready ? 'health-ok' : 'health-warn'}`} title={title} aria-label={title}>
      <span className="health-dot" />
      <span className="health-mode">{mode}</span>
      <span className="health-keys" aria-hidden="true">
        <span className={health.nebius ? 'key-on' : 'key-off'}>Nebius</span>
        <span className={health.tavily ? 'key-on' : 'key-off'}>Tavily</span>
      </span>
    </span>
  );
}
