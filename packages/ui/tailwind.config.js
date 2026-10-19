/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  // Every utility is emitted as `[data-jaw-ui] .foo`, so the SDK's styles cannot leak into a host
  // page and a host's identically-named utility cannot win inside our subtree. Everything the SDK
  // renders lives under one element carrying this attribute (portals included, via
  // PortalContainerContext), so nothing escapes the scope.
  important: '[data-jaw-ui]',
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  // Disable preflight to prevent global CSS resets in consuming apps
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      // Inter carries the interface. JetBrains Mono carries anything a user might verify —
      // addresses, amounts, hashes, labels. 9px is the floor for every role here; the sole
      // sub-9px value in the package is the EIP-712 tree's raw 7px type badge (see Eip712Tree).
      // Sizes are the spec's own px. They were briefly scaled by 400/350 to match the proportions
      // of the sheet's narrower card; that was wrong — the card is wider, not taller, so the extra
      // 50px buys room for long ENS names and addresses rather than asking for larger type. Only
      // the title keeps a raised value (26 over the spec's 24), by explicit request.
      //
      // Every role also fixes its own line-height. The spec annotates gaps between text and the box
      // around it, and an inherited line-height makes those gaps unreproducible — the same `pt-6`
      // lands differently depending on what the text sits inside. Weights are the designer's; the
      // line-heights are ours, chosen so the measured boxes come out right.
      fontSize: {
        // ── Annotated on the spec sheet's transaction frame ────────────────────────────────────
        'title-xl': ['26px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.03em' }], // spec 24, raised by request
        // Same face as title-xl one step down — the permission grant/revoke titles only, whose
        // two-word headings read better at 24 (by request). Every other card title stays title-xl.
        'title-lg': ['24px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.03em' }],
        heading: ['13px', { lineHeight: '1', fontWeight: '600', letterSpacing: '-0.02em' }], // "You send"
        button: ['13px', { lineHeight: '1', fontWeight: '600' }], // Cancel / Confirm
        value: ['12px', { lineHeight: '1.25', fontWeight: '500' }], // field value, asset amount
        body: ['12px', { lineHeight: '1.4', fontWeight: '400' }],
        'body-xs': ['10px', { lineHeight: '1.3', fontWeight: '400' }], // USD equivalent, chain name
        // Spec says 9; raised to 10 by request. Measuring the sheet's own "NETWORK FEE" also came
        // out at ~10, so the 9 may only ever have applied to the FROM/TO pair.
        label: ['10px', { lineHeight: '1', fontWeight: '600', letterSpacing: '0.13em' }], // mono caps label

        // ── Measured off the same frame, not annotated ─────────────────────────────────────────
        // Derived from ink height against the annotated roles (a 13px ascender measures 10.0 spec
        // px, 9px caps measure 6.7), so these carry roughly ±0.5px of measurement error.
        amount: ['16px', { lineHeight: '1.2', fontWeight: '600' }], // fee figure "$0.84"
        symbol: ['14px', { lineHeight: '1.2', fontWeight: '600' }], // asset symbol "USDC" — measured, ±1

        // ── Beyond the spec ───────────────────────────────────────────────────────────────────
        // Screens the sheet never framed. Kept in one block so they can be taken back to design
        // and either adopted or collapsed into the roles above.
        'body-sm': ['11px', { lineHeight: '1.4', fontWeight: '400' }],
        code: ['9px', { lineHeight: '1.4', fontWeight: '400' }], // mono, hashes and raw payload
        'amount-lg': ['26px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.02em' }], // native-send hero
        status: ['15px', { lineHeight: '1.2', fontWeight: '600', letterSpacing: '-0.02em' }], // processing / success headline
        // Deleted once as unused, reinstated when AccountHeaderRow's heading moved off `status`:
        // "Sign In as" / "Signing as" / "Connecting to" read at 20 where the processing headline
        // stays 15. Size raised by request; weight and tracking kept from the row's prior look.
        title: ['20px', { lineHeight: '1.2', fontWeight: '600', letterSpacing: '-0.02em' }],
        app: ['17px', { lineHeight: '1.2', fontWeight: '600', letterSpacing: '-0.02em' }], // app name, dialog header
        url: ['10px', { lineHeight: '1.3', fontWeight: '400' }], // mono origin, under the app name
      },

      // Tailwind's default box-shadows bake literal black; re-declare sm/md/lg/xl on the
      // shadow token so a dApp skin can tint (or kill) elevation. Same offsets/blurs as stock.
      // (md covers PopoverContent — the fee-token selector inside the dialogs.)
      boxShadow: {
        sm: '0 1px 2px 0 oklch(var(--jaw-color-shadow) / 0.05)',
        md: '0 4px 6px -1px oklch(var(--jaw-color-shadow) / 0.1), 0 2px 4px -2px oklch(var(--jaw-color-shadow) / 0.1)',
        lg: '0 10px 15px -3px oklch(var(--jaw-color-shadow) / 0.1), 0 4px 6px -4px oklch(var(--jaw-color-shadow) / 0.1)',
        xl: '0 20px 25px -5px oklch(var(--jaw-color-shadow) / 0.1), 0 8px 10px -6px oklch(var(--jaw-color-shadow) / 0.1)',
      },

      // Radii: 99 · 16.5 · 12 · 8 · 4. Nothing else is legal.
      borderRadius: {
        card: '16.5px',
        box: '12px',
        chip: '8px',
        xs: '4px',
        pill: '99px',
        // Pre-existing shadcn aliases — `rounded-lg/md/sm` are used by buttons, tooltip and
        // checkbox, and resolve to the radius CSS variable rather than a spec value.
        lg: 'var(--jaw-radius)',
        md: 'calc(var(--jaw-radius) - 2px)',
        sm: 'calc(var(--jaw-radius) - 4px)',
      },

      // Object sizes the spec fixes by name. The 4/8/12/16/20/24 spacing scale is Tailwind's own
      // 1/2/3/4/5/6, so spacing needs no tokens — only the habit of not writing px.
      //
      // The avatar ladder, smallest first. Every size here is rendered somewhere; `blob-lg` used to
      // say 34px, which nothing drew, and `logo` said 48 while the two app-logo sites disagreed
      // (48 in the header, 44 on the processing screen). One value each now, so they cannot drift.
      size: {
        badge: '16px', // chain badge
        blob: '15px', // account blob, inline — in a MetaCard row
        'blob-lg': '28px', // account avatar in a party row (From / To / Interacting with)
        token: '24px', // token logo — sheet annotates 21; raised by request, still under blob-lg
        logo: '44px', // app logo circle — dialog header and processing screen
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        background: 'oklch(var(--jaw-color-background) / <alpha-value>)',
        foreground: 'oklch(var(--jaw-color-foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'oklch(var(--jaw-color-card) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'oklch(var(--jaw-color-popover) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'oklch(var(--jaw-color-primary) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--jaw-color-secondary) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--jaw-color-muted) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'oklch(var(--jaw-color-accent) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'oklch(var(--jaw-color-destructive) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-destructive-foreground) / <alpha-value>)',
          // `hover:bg-destructive-hover` on the revoke button. Without this key the class emitted
          // no CSS — it only ever worked because a host app compiled our source with its own theme.
          hover: 'oklch(var(--jaw-color-destructive-hover) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'oklch(var(--jaw-color-success) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'oklch(var(--jaw-color-warning) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-warning-foreground) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'oklch(var(--jaw-color-info) / <alpha-value>)',
          foreground: 'oklch(var(--jaw-color-info-foreground) / <alpha-value>)',
        },
        // Text-legible asset-delta pair. `destructive`/`success` are fill colors — dark
        // destructive (L 0.396) is unreadable as small text, which is why red-400 crept in.
        positive: 'oklch(var(--jaw-color-positive) / <alpha-value>)',
        negative: 'oklch(var(--jaw-color-negative) / <alpha-value>)',
        scrim: 'oklch(var(--jaw-color-scrim) / <alpha-value>)',
        halo: 'oklch(var(--jaw-color-halo) / <alpha-value>)',
        'identicon-tile': 'oklch(var(--jaw-color-identicon-tile) / <alpha-value>)',
        'identicon-ring': 'oklch(var(--jaw-color-identicon-ring) / <alpha-value>)',
        border: 'oklch(var(--jaw-color-border) / <alpha-value>)',
        input: 'oklch(var(--jaw-color-input) / <alpha-value>)',
        ring: 'oklch(var(--jaw-color-ring) / <alpha-value>)',
        chart: {
          1: 'oklch(var(--jaw-color-chart-1) / <alpha-value>)',
          2: 'oklch(var(--jaw-color-chart-2) / <alpha-value>)',
          3: 'oklch(var(--jaw-color-chart-3) / <alpha-value>)',
          4: 'oklch(var(--jaw-color-chart-4) / <alpha-value>)',
          5: 'oklch(var(--jaw-color-chart-5) / <alpha-value>)',
        },
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
