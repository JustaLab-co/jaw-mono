'use client';

export function EureLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="EURe">
      <circle cx="12" cy="12" r="12" fill="#2D5BFF" />
      <path
        d="M15.6 8.2a4.6 4.6 0 1 0 0 7.6M6.8 10.6h6.4M6.8 13.4h6.4"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
