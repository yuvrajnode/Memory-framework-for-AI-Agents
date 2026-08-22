/**
 * Inline icon set.
 *
 * Hand-drawn on a 24-unit grid at a consistent 1.6 stroke, rather than pulled
 * from an icon package: a dozen glyphs is not worth a dependency, and drawing
 * them here keeps the weight matched to the type.
 */
const PATHS = {
  console: 'M4 6h16M4 12h10M4 18h7',
  memories: 'M5 4h14v16l-7-3.5L5 20z',
  graph: 'M12 5.5a2.5 2.5 0 1 0 0-.01M6 18.5a2.5 2.5 0 1 0 0-.01M18 18.5a2.5 2.5 0 1 0 0-.01M11 7.8 7 16.2M13 7.8l4 8.4M8.6 18.5h6.8',
  insights: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  maintenance: 'M6 4v6a6 6 0 0 0 12 0V4M12 16v4M8 20h8',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  chevron: 'm9 6 6 6-6 6',
  spark: 'm12 3 2.2 5.9L20 11l-5.8 2.1L12 19l-2.2-5.9L4 11l5.8-2.1z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'm5 12.5 4.5 4.5L19 7',
  warning: 'M12 4 2.5 20h19zM12 10v4M12 17.2v.1',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
