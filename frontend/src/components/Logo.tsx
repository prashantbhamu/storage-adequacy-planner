/**
 * Mark: the supply − demand wave before storage (faint) and after (bold),
 * flattened through a storage node. Shared by the header and the favicon.
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="logo-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#12a386" />
          <stop offset="100%" stopColor="#0a5e70" />
        </linearGradient>
        <linearGradient id="logo-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#logo-tile)" />
      <rect width="32" height="32" rx="9" fill="url(#logo-shine)" />
      <path d="M4.5 16C7.5 16 8.3 7.5 11 7.5S14.4 16 16 16S18.3 24.5 21 24.5S24.5 16 27.5 16"
        fill="none" stroke="#ffffff" strokeOpacity="0.38" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M4.5 16C7.5 16 8.3 12 11 12S14.4 16 16 16S18.3 20 21 20S24.5 16 27.5 16"
        fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.4" fill="#ffffff" />
      <circle cx="16" cy="16" r="1.1" fill="#0d7f79" />
    </svg>
  );
}
