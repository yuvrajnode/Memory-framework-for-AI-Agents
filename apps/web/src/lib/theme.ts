import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'mnemos.theme';

function currentTheme(): Theme {
  const attribute = document.documentElement.getAttribute('data-theme');
  return attribute === 'dark' ? 'dark' : 'light';
}

/**
 * Theme state, kept in sync with the pre-paint script in index.html.
 *
 * That script owns the first paint; this hook only reads what it decided and
 * handles subsequent toggles, so the two can never disagree.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private browsing or a blocked storage policy; the theme still applies
      // for this session, it just will not be remembered.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return [theme, toggle];
}
