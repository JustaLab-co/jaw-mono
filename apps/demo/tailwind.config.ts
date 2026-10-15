import type { Config } from 'tailwindcss';

// Palette mirrors the JAW Hero Demo design tokens declared as CSS vars in
// app/globals.css, so `text-ink-2`, `border-line`, `bg-raise` etc. work.
const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        paper: 'var(--bg)',
        raise: {
          DEFAULT: 'var(--bg-raise)',
          '2': 'var(--bg-raise-2)',
        },
        line: {
          DEFAULT: 'var(--line)',
          '2': 'var(--line-2)',
        },
        ink: {
          DEFAULT: 'var(--ink)',
          '2': 'var(--ink-2)',
          '3': 'var(--ink-3)',
          '4': 'var(--ink-4)',
        },
        acc: {
          DEFAULT: 'var(--acc)',
          deep: 'var(--acc-deep)',
          soft: 'var(--acc-soft)',
        },
        'jaw-blue': 'var(--jaw-blue)',
        amber: {
          DEFAULT: 'var(--amber)',
          bg: 'var(--amber-bg)',
          line: 'var(--amber-line)',
        },
        red: {
          DEFAULT: 'var(--red)',
          bg: 'var(--red-bg)',
          line: 'var(--red-line)',
        },
        // Object-valued so it deep-merges with Tailwind's green scale instead
        // of replacing it (a bare string would kill text-green-600 etc.).
        green: { DEFAULT: 'var(--green)' },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jbmono)', 'ui-monospace', 'monospace'],
        display: ['var(--font-playfair)', 'Georgia', 'serif'],
      },
      keyframes: {
        'jd-spin': {
          to: { transform: 'rotate(360deg)' },
        },
        // Coin flip for the funding overlay's EURe mark (needs a perspective
        // on the parent to read as 3D).
        'jd-coin': {
          to: { transform: 'rotateY(360deg)' },
        },
        'jd-pop': {
          from: { transform: 'scale(.6)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        'jd-fade': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'hd-live': {
          '50%': { opacity: '.35' },
        },
        'sw-blink': {
          '50%': { opacity: '0' },
        },
        // Background-agnostic attention pulse: a wide two-tone ring (white +
        // ink read on both light and dark screens) plus a brightness throb.
        'hd-pulse': {
          '0%, 100%': {
            boxShadow:
              '0 12px 28px -12px rgba(15,23,42,.45), 0 0 0 0 rgba(255,255,255,.45), 0 0 0 0 rgba(15,23,42,.22)',
            filter: 'brightness(1)',
          },
          '50%': {
            boxShadow:
              '0 12px 28px -12px rgba(15,23,42,.45), 0 0 0 6px rgba(255,255,255,0), 0 0 0 9px rgba(15,23,42,0)',
            filter: 'brightness(1.09)',
          },
        },
        'hd-fin-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'hd-fin-fade': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'jd-spin': 'jd-spin .9s linear infinite',
        'jd-coin': 'jd-coin 1.4s cubic-bezier(.45,.05,.55,.95) infinite',
        'jd-pop': 'jd-pop .45s cubic-bezier(.2,.7,.2,1.2) both',
        'jd-fade': 'jd-fade .35s ease both',
        'hd-live': 'hd-live 1.6s ease-in-out infinite',
        'sw-blink': 'sw-blink 1.1s step-end infinite',
        'hd-pulse': 'hd-pulse 2.0s ease-out infinite',
        'hd-fin-up': 'hd-fin-up .52s cubic-bezier(.22,1,.36,1) both',
        'hd-fin-fade': 'hd-fin-fade .4s ease both',
      },
    },
  },
  plugins: [],
};
export default config;
