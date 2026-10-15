'use client';

import type { JawTheme } from '@jaw.id/core';
import type { FeatureName } from '@/lib/analytics/events/types';

export type PhoneAppKey = 'social' | 'splits' | 'agent';

export type Variant = {
  key: string;
  label: string;
  desc: string;
  app?: PhoneAppKey;
  appLabel?: string;
  accent?: string;
};

export type Feat = {
  id: number;
  /** Stable analytics name — decoupled from `title` so copy edits keep funnels intact. */
  analytics: FeatureName;
  app: PhoneAppKey;
  appLabel: string;
  accent: string;
  title: string;
  teaser: string;
  variants: Variant[];
  /** Theme pushed to the keys dialog while this feature is active. */
  theme?: JawTheme;
};

// Three features, one path each.
export const FEATS: Feat[] = [
  {
    id: 1,
    analytics: 'sign-in',
    app: 'social',
    appLabel: 'Social app',
    accent: 'rgb(8,81,255)',
    title: 'Sign in / Sign up',
    teaser: 'A passkey. Face ID or fingerprint, no seed phrase.',
    theme: {
      mode: 'light',
      colors: {
        primary: '#0851FF',
        primaryForeground: '#FFFFFF',
        ring: '#0851FF',
      },
    },
    variants: [
      {
        key: 'happy',
        label: 'Happy path',
        desc: 'Onboarding is a single passkey prompt: it creates a hardware-secured account, claims a name, and signs the user in. No seed phrase, no extension, no ETH required, on Arbitrum Sepolia.',
      },
    ],
  },
  {
    id: 2,
    analytics: 'send',
    app: 'splits',
    appLabel: 'Splitos',
    accent: '#C29A34',
    title: 'Send',
    teaser: 'Amount and fee in one token, no gas token to top up.',
    // Unlike sign-in's single accent swap, splits dresses the dialog like the
    // app's own Settle Up sheet: cream drawer surface (popover is what the
    // sheet is painted with), white inner cards, navy type, gold actions.
    theme: {
      mode: 'light',
      borderRadius: 'lg',
      colors: {
        background: '#F4F5F7',
        foreground: '#16233F',
        card: '#FFFFFF',
        cardForeground: '#16233F',
        popover: '#F4F5F7',
        popoverForeground: '#16233F',
        primary: '#C29A34',
        primaryForeground: '#FFFFFF',
        secondary: '#E9EBEF',
        secondaryForeground: '#16233F',
        muted: '#E9EBEF',
        mutedForeground: '#5A6379',
        accent: '#E9EBEF',
        accentForeground: '#16233F',
        border: '#DDE0E6',
        input: '#DDE0E6',
        ring: '#C29A34',
        positive: '#1E7A45',
        negative: '#C81E33',
        scrim: '#16233F',
      },
    },
    variants: [
      {
        key: 'happy',
        label: 'Happy path',
        desc: 'Pay friends in euros with one confirmation for both transfers. The network fee is paid in EURe too. No gas token, no top-up.',
      },
    ],
  },
  {
    id: 3,
    analytics: 'agent-delegation',
    app: 'agent',
    appLabel: 'AI agent',
    accent: '#5FE0A0',
    title: 'Agent delegation',
    teaser: 'Scoped limits on amount and duration.',
    // The copy-edit design paints Agens deep green ("ox"): the dialog follows
    // with green chat surfaces and the emerald primary.
    theme: {
      mode: 'dark',
      colors: {
        background: '#10312A',
        foreground: '#EAF7F1',
        card: '#18443B',
        cardForeground: '#EAF7F1',
        popover: '#10312A',
        popoverForeground: '#EAF7F1',
        primary: '#10B981',
        primaryForeground: '#04110C',
        secondary: '#1B4A40',
        secondaryForeground: '#A9F0D7',
        muted: '#18443B',
        mutedForeground: '#9DB8AE',
        accent: '#1B4A40',
        accentForeground: '#6EE7B7',
        border: '#2A574C',
        input: '#336357',
        ring: '#10B981',
        success: '#10B981',
        positive: '#34D399',
        scrim: '#04110C',
      },
    },
    variants: [
      {
        key: 'happy',
        label: 'Happy path',
        desc: "An agent with your keys can do anything. An agent with a JAW permission can do exactly what you allowed: this token, 25 EURe a day, 30 days. The limit lives onchain, in the account, so overspending isn't a risk to monitor. It's a transaction that reverts.",
      },
    ],
  },
];
