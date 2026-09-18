# @jaw.id/ui

Pre-built React dialogs for [JAW.id](https://jaw.id) wallet interactions: onboarding, transaction signing, permissions, and more.

## Documentation

For documentation and guides, visit [docs.jaw.id](https://docs.jaw.id).

## Installation

```bash
npm install @jaw.id/ui
# or
bun add @jaw.id/ui
```

## Quick Start

```tsx
import { JAW } from '@jaw.id/core';
import { ReactUIHandler } from '@jaw.id/ui';

const uiHandler = new ReactUIHandler();

const jaw = JAW.create({
  apiKey: 'your-api-key',
  appName: 'My App',
  preference: {
    mode: 'AppSpecific',
    uiHandler,
  },
});
```

## AI-Assisted Development

Add JAW.id skills to your AI coding agent:

```bash
npx skills add JustaLab-co/jaw-skills
```

## License

[Apache-2.0](./LICENSE)
