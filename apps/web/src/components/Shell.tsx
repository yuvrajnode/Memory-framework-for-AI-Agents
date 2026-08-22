import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { useBackend } from '../lib/backend-context.js';
import { useTheme } from '../lib/theme.js';
import { compactNumber } from '../lib/format.js';

export type ViewId = 'console' | 'memories' | 'graph' | 'insights' | 'maintenance';

interface NavEntry {
  id: ViewId;
  label: string;
  icon: IconName;
  key: string;
}

const NAV: NavEntry[] = [
  { id: 'console', label: 'Console', icon: 'console', key: '1' },
  { id: 'memories', label: 'Memories', icon: 'memories', key: '2' },
  { id: 'graph', label: 'Graph', icon: 'graph', key: '3' },
  { id: 'insights', label: 'Insights', icon: 'insights', key: '4' },
  { id: 'maintenance', label: 'Maintenance', icon: 'maintenance', key: '5' },
];

export function Shell({
  view,
  onNavigate,
  title,
  hint,
  actions,
  children,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { backend, namespace, setNamespace, ready, revision } = useBackend();
  const [theme, toggleTheme] = useTheme();

  // Number keys jump between views, but never while the user is typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const entry = NAV.find((item) => item.key === event.key);
      if (entry) {
        event.preventDefault();
        onNavigate(entry.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onNavigate]);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <div className="wordmark">
          <span className="wordmark__name">Mnemos</span>
          <span className="wordmark__version">v0.1</span>
        </div>

        <div className="nav">
          {NAV.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="nav__item"
              aria-current={entry.id === view ? 'page' : undefined}
              onClick={() => onNavigate(entry.id)}
            >
              <Icon name={entry.icon} />
              {entry.label}
              <kbd className="nav__key">{entry.key}</kbd>
            </button>
          ))}
        </div>

        <div className="rail__spacer" />

        <NamespacePicker
          namespace={namespace}
          onChange={setNamespace}
          revision={revision}
        />

        <div className="rail__section">
          <span className="label">Backend</span>
          <div className="row row--tight xs muted">
            <span
              className={`dot ${ready ? (backend.kind === 'remote' ? 'dot--live' : '') : 'dot--offline'}`}
            />
            <span>{backend.label}</span>
          </div>
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </nav>

      <main>
        <header className="topbar">
          <h1 className="topbar__title">{title}</h1>
          {hint && <span className="topbar__hint">{hint}</span>}
          {actions && <div className="topbar__actions">{actions}</div>}
        </header>
        <div className="page">{children}</div>
      </main>
    </div>
  );
}

function NamespacePicker({
  namespace,
  onChange,
  revision,
}: {
  namespace: string;
  onChange: (namespace: string) => void;
  revision: number;
}) {
  const { backend } = useBackend();
  const [options, setOptions] = useState<{ namespace: string; count: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void backend.namespaces().then((result) => {
      if (cancelled) return;
      setOptions(result.length > 0 ? result : [{ namespace: 'default', count: 0 }]);
    });
    return () => {
      cancelled = true;
    };
  }, [backend, revision]);

  // A namespace the operator has switched to but not yet written into does not
  // exist in the store, so it is kept in the list locally rather than
  // vanishing from the picker on the next refresh.
  const withCurrent = options.some((option) => option.namespace === namespace)
    ? options
    : [...options, { namespace, count: 0 }];

  return (
    <div className="rail__section">
      <label className="label" htmlFor="namespace-picker">
        Namespace
      </label>
      <select
        id="namespace-picker"
        className="select"
        value={namespace}
        onChange={(event) => onChange(event.target.value)}
      >
        {withCurrent.map((option) => (
          <option key={option.namespace} value={option.namespace}>
            {option.namespace} · {compactNumber(option.count)}
          </option>
        ))}
      </select>
    </div>
  );
}
