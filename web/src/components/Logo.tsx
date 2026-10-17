/** Menusmith mark: a fork resting on an anvil. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g fill="var(--on-accent)">
        <rect x="13.1" y="4" width="1.5" height="5" rx="0.75" />
        <rect x="15.25" y="4" width="1.5" height="5" rx="0.75" />
        <rect x="17.4" y="4" width="1.5" height="5" rx="0.75" />
        <path d="M13.1 8.3h5.8v.6a2.9 2.9 0 0 1-2.15 2.8V14h-1.5v-2.3a2.9 2.9 0 0 1-2.15-2.8z" />
        <path d="M4.5 14.5h20.5c.83 0 1.5.67 1.5 1.5v.5c0 .83-.67 1.5-1.5 1.5H22l-2 3h3.5c.55 0 1 .45 1 1V24H7.5v-2c0-.55.45-1 1-1H12l-2-3H9c-2.5 0-4.2-1.4-4.5-3.5z" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark />
      <span className="wordmark-text">Menusmith</span>
    </span>
  );
}
