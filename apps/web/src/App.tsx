import { useCallback, useEffect, useState } from 'react';
import { Shell, type ViewId } from './components/Shell.js';
import { ConsoleView } from './views/ConsoleView.js';
import { MemoriesView } from './views/MemoriesView.js';
import { GraphView } from './views/GraphView.js';
import { InsightsView } from './views/InsightsView.js';
import { MaintenanceView } from './views/MaintenanceView.js';

const VIEWS: ViewId[] = ['console', 'memories', 'graph', 'insights', 'maintenance'];

function viewFromHash(): ViewId {
  const hash = window.location.hash.replace(/^#\/?/, '') as ViewId;
  return VIEWS.includes(hash) ? hash : 'console';
}

const TITLES: Record<ViewId, { title: string; hint: string }> = {
  console: { title: 'Console', hint: 'Write, recall, and assemble context' },
  memories: { title: 'Memories', hint: 'Browse and edit what the agent knows' },
  graph: { title: 'Graph', hint: 'Associations between memories' },
  insights: { title: 'Insights', hint: 'Composition, retention and decay' },
  maintenance: { title: 'Maintenance', hint: 'Consolidate, expire and evict' },
};

/**
 * Hash routing rather than a router dependency.
 *
 * Five views with no nested routes and no route params do not justify one,
 * and hash URLs deploy to any static host without server rewrites.
 */
export function App() {
  const [view, setView] = useState<ViewId>(() => viewFromHash());

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: ViewId) => {
    window.location.hash = `/${next}`;
    setView(next);
  }, []);

  const { title, hint } = TITLES[view];

  return (
    <Shell view={view} onNavigate={navigate} title={title} hint={hint}>
      {view === 'console' && <ConsoleView />}
      {view === 'memories' && <MemoriesView />}
      {view === 'graph' && <GraphView />}
      {view === 'insights' && <InsightsView />}
      {view === 'maintenance' && <MaintenanceView />}
    </Shell>
  );
}
