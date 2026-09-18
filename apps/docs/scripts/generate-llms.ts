import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkStringify from 'remark-stringify';
import { toMarkdown } from 'mdast-util-to-markdown';
import { mdxToMarkdown } from 'mdast-util-mdx';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { visit } from 'unist-util-visit';
import type { Heading } from 'mdast';

// Use fileURLToPath for ESM compatibility across environments
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// apps/docs is the root of the docs app
const DOCS_APP_ROOT = join(__dirname, '..');
const PAGES_DIR = join(DOCS_APP_ROOT, 'docs/pages');

// Find the served web root(s) - Vocs outputs to different locations locally vs Vercel.
// Vocs v2's Vercel adapter copies `<outDir>/public` -> `.vercel/output/static` DURING
// `vocs build`, i.e. BEFORE this script runs. So overwriting only `<outDir>/public`
// (as a single-dir lookup did) never reaches the deployed site: Vercel ships
// `.vercel/output/static`, which already holds Vocs's native llms.txt. We therefore
// write to EVERY served root that exists so both local preview (`docs/dist/public`)
// and the Vercel deployment (`.vercel/output/static`) get the custom files.
// `.vercel/output` is created by the adapter relative to the build command's cwd,
// which in CI (`vercel build`) can be the project root directory (apps/docs) OR the
// monorepo root depending on the project's Root Directory setting. We probe both the
// script-relative location and process.cwd() so the path resolves regardless.
function findDistDirs(): string[] {
  const candidates = [
    join(DOCS_APP_ROOT, '.vercel/output/static'), // Vercel served root (cwd = apps/docs)
    join(process.cwd(), '.vercel/output/static'), // Vercel served root (cwd = monorepo root)
    join(DOCS_APP_ROOT, 'docs/dist/public'), // Vocs v2: full-static web root
    join(DOCS_APP_ROOT, 'docs/dist'), // Fallback: non-static / older layout
  ];

  // De-dupe (cwd may equal DOCS_APP_ROOT) and keep only roots that actually exist.
  const found = [...new Set(candidates)].filter((candidate) => existsSync(candidate));

  if (found.length === 0) {
    throw new Error(`Dist directory not found. Checked: ${candidates.join(', ')}`);
  }

  return found;
}

// DIST_DIRS is resolved lazily inside main() to ensure vocs build has completed
let DIST_DIRS: string[];

const BASE_URL = 'https://docs.jaw.id';

// Domain configuration with rich headers for LLM discoverability
interface DomainConfig {
  title: string;
  description: string;
  dirs: string[];
  includes: string[];
  packageName?: string;
  installCommand?: string;
  quickExample?: string;
}

const DOMAINS: Record<string, DomainConfig> = {
  wagmi: {
    title: 'JAW Wagmi Integration',
    description: 'Wagmi connector and React hooks for integrating JAW smart accounts into React/Next.js applications.',
    dirs: ['wagmi'],
    includes: [],
    packageName: '@jaw.id/wagmi',
    installCommand: 'npm install @jaw.id/wagmi wagmi @tanstack/react-query',
    quickExample: `import { jaw } from '@jaw.id/wagmi';
import { createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';

const config = createConfig({
  chains: [base],
  connectors: [
    jaw({
      apiKey: 'YOUR_API_KEY',
      appName: 'My App',
    }),
  ],
  transports: { [base.id]: http() },
});`,
  },
  core: {
    title: 'JAW Provider - RPC Reference',
    description: 'EIP-1193 compliant provider with full RPC method support for smart account operations.',
    dirs: ['api-reference'],
    includes: [],
    packageName: '@jaw.id/core',
    installCommand: 'npm install @jaw.id/core',
    quickExample: `import { JAW } from '@jaw.id/core';

const provider = await JAW.create({
  apiKey: 'YOUR_API_KEY',
  appName: 'My App',
  chains: [{ id: 8453, rpcUrl: 'https://mainnet.base.org' }],
});

// EIP-1193 compliant - use with any library
const accounts = await provider.request({ method: 'eth_requestAccounts' });`,
  },
  account: {
    title: 'JAW Account API',
    description:
      'Direct smart account operations including signing, transactions, and permission management. The same API is used on React Native.',
    dirs: ['account'],
    includes: [],
    packageName: '@jaw.id/core',
    installCommand: 'npm install @jaw.id/core',
    quickExample: `import { JAW } from '@jaw.id/core';

const provider = await JAW.create({ apiKey: 'KEY', appName: 'App', chains: [...] });
const account = provider.getAccount();

// Send a transaction
const hash = await account.sendTransaction({
  to: '0x...',
  value: parseEther('0.01'),
});`,
  },
  quickstart: {
    title: 'JAW Quickstart & Guides',
    description:
      'Getting started with JAW smart accounts - setup, tutorials, and common use cases, including React Native (Expo) apps.',
    dirs: ['guides'],
    includes: ['index.mdx', 'supported-networks.mdx'],
    packageName: '@jaw.id/wagmi (React) or @jaw.id/core (vanilla JS, React Native)',
    installCommand: 'npm install @jaw.id/wagmi wagmi @tanstack/react-query',
    quickExample: `// 1. Get API key at https://dashboard.jaw.id
// 2. Install packages
// 3. Configure connector (see full docs below)`,
  },
  configuration: {
    title: 'JAW Configuration Reference',
    description: 'Configuration options for JAW - applies to both core and wagmi integrations.',
    dirs: ['configuration'],
    includes: [],
    packageName: '@jaw.id/wagmi or @jaw.id/core',
    quickExample: `jaw({
  apiKey: 'YOUR_API_KEY',      // Required - from dashboard.jaw.id
  appName: 'My App',           // Required - shown in passkey prompts
  mode: 'crossPlatform',       // Optional - 'crossPlatform' | 'appSpecific'
  paymasterUrl: '...',         // Optional - for gas sponsoring
  ensConfig: { ... },          // Optional - for ENS subnames
})`,
  },
  cli: {
    title: 'JAW CLI & MCP Server',
    description:
      'Command-line interface and MCP server for interacting with JAW smart accounts from terminal, shell scripts, or AI agents.',
    dirs: ['cli'],
    includes: [],
    packageName: '@jaw.id/cli',
    installCommand: 'npm install -g @jaw.id/cli',
    quickExample: `# Configure
jaw config set apiKey=YOUR_KEY defaultChain=8453

# Connect wallet (opens browser for passkey)
jaw rpc call wallet_connect

# Send a transaction
jaw rpc call wallet_sendCalls '{"calls":[{"to":"0x...","value":"0xDE0B6B3A7640000"}]}'

# JSON output for scripts/agents
jaw rpc call eth_accounts -o json -y`,
  },
  advanced: {
    title: 'JAW Advanced Topics',
    description:
      'Advanced implementation details - custom UI handlers, passkey server setup, and specialized configurations.',
    dirs: ['advanced'],
    includes: [],
    packageName: '@jaw.id/core + @jaw.id/ui',
    installCommand: 'npm install @jaw.id/core @jaw.id/ui',
    quickExample: `// App-specific mode with custom UI
import { JAW } from '@jaw.id/core';
import { ReactUIHandler } from '@jaw.id/ui';

const provider = await JAW.create({
  apiKey: 'KEY',
  appName: 'App',
  mode: 'appSpecific',
  uiHandler: new ReactUIHandler(),
  chains: [...],
});`,
  },
};

function getAllMdxFiles(dir: string): string[] {
  const files: string[] = [];

  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...getAllMdxFiles(fullPath));
    } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseMdxFile(filePath: string): { title: string; content: string } {
  const raw = readFileSync(filePath, 'utf-8');

  const parser = unified().use(remarkParse).use(remarkMdx).use(remarkStringify);

  const ast = parser.parse(raw);

  // Extract title from first H1
  let title = basename(filePath, '.mdx');
  visit(ast, { type: 'heading', depth: 1 }, (node: Heading) => {
    const textNode = node.children[0];
    if (textNode && textNode.type === 'text') {
      title = textNode.value;
    }
  });

  // Shift all headings down by 1 level for context files
  visit(
    ast,
    (n) => n.type === 'heading',
    (n) => {
      const node = n as Heading;
      if (node.depth >= 1 && node.depth <= 4) {
        node.depth = (node.depth + 1) as 2 | 3 | 4 | 5;
      }
    }
  );

  // Remove frontmatter
  visit(ast, { type: 'yaml' }, (_, i, p) => {
    if (p && typeof i === 'number') {
      p.children.splice(i, 1);
    }
  });

  const content = toMarkdown(ast, {
    extensions: [gfmToMarkdown(), mdxToMarkdown()],
  });

  return { title, content };
}

function generateDomainFile(domainKey: string, domain: DomainConfig): string {
  const lines: string[] = [
    `# ${domain.title}`,
    '',
    `> ${domain.description}`,
    '',
    '**This file is self-contained.** You have everything needed to help with this topic. Do NOT fetch other llms-*.txt files unless the user explicitly asks about a different topic.',
    '',
  ];

  // Add key info section
  lines.push('## Key Info');
  if (domain.packageName) {
    lines.push(`- **Package:** \`${domain.packageName}\``);
  }
  if (domain.installCommand) {
    lines.push(`- **Install:** \`${domain.installCommand}\``);
  }
  lines.push('- **Dashboard:** https://dashboard.jaw.id');
  lines.push('- **Docs:** https://docs.jaw.id');
  lines.push('');

  // Add quick example
  if (domain.quickExample) {
    lines.push('## Quick Example');
    lines.push('```typescript');
    lines.push(domain.quickExample);
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // Collect all files for this domain
  const files: string[] = [];

  // Add files from specified directories
  for (const dir of domain.dirs) {
    const dirPath = join(PAGES_DIR, dir);
    files.push(...getAllMdxFiles(dirPath));
  }

  // Add specific included files
  for (const include of domain.includes) {
    const filePath = join(PAGES_DIR, include);
    if (existsSync(filePath)) {
      files.push(filePath);
    }
  }

  // Sort files for consistent output
  files.sort();

  // Process each file
  for (const file of files) {
    try {
      const { title, content } = parseMdxFile(file);
      const relativePath = file.replace(PAGES_DIR, '').replace(/\.(mdx|md)$/, '');

      lines.push(`## ${title}`);
      lines.push(`Source: ${BASE_URL}${relativePath}`);
      lines.push('');
      lines.push(content);
      lines.push('');
    } catch (e) {
      console.error(`Error processing ${file}:`, e);
    }
  }

  return lines.join('\n');
}

function generateRoutingIndex(): string {
  return `# JAW Documentation

> TypeScript SDK for identity-first smart accounts with passkey authentication and programmable permissions.

JAW provides an EIP-1193 compliant provider for creating and managing smart accounts on EVM chains. Supports cross-platform (popup) and app-specific (embedded) authentication modes, with extensible permission delegation for apps and AI agents.

## Instructions for AI Assistants

This file is a **routing index only**. To help users with JAW:

1. **Read the routing table below** to identify which file matches the user's question
2. **Fetch exactly ONE file** — the single best match
3. **Answer using that file's content**

**IMPORTANT:**
- Do NOT answer questions using only this routing file — it lacks implementation details
- Do NOT fetch multiple files at once — each domain file is self-contained
- Do NOT guess — if unclear, ask the user what they're trying to build

## Routing Table

### llms-wagmi.txt — React/Next.js Integration
**Use this when:** User is building a React or Next.js app and wants to integrate JAW wallet
**Example questions:**
- "How do I add a connect wallet button in React?"
- "How do I get the connected account in my Next.js app?"
- "How do I set up JAW with wagmi?"
- "How do I disconnect the wallet?"
- "How do I check if the user is connected?"
**Package:** \`@jaw.id/wagmi\`
**URL:** ${BASE_URL}/llms-wagmi.txt

### llms-core.txt — EIP-1193 Provider & RPC Methods
**Use this when:** User needs low-level provider access, isn't using React, or wants to make raw RPC calls
**Example questions:**
- "How do I use JAW without React?"
- "How do I send a transaction with the provider?"
- "How do I call wallet_sendCalls?"
- "How do I integrate JAW with vanilla JavaScript?"
- "What RPC methods does JAW support?"
**Package:** \`@jaw.id/core\`
**URL:** ${BASE_URL}/llms-core.txt

### llms-account.txt — Account API & Direct Operations
**Use this when:** User wants headless integration (No UI) or needs to issue smart wallets for AI Agents
**Example questions:**
- "How do I create smart wallets for AI agents?"
- "How do I use JAW without any UI?"
- "How do I send a transaction from the account?"
- "How do I sign a message?"
- "How do I sign typed data (EIP-712)?"
- "How do I get the account address?"
- "How do I send multiple transactions in one call?"
- "How do I create wallets programmatically for agents?"
**Package:** \`@jaw.id/core\` (Account class)
**URL:** ${BASE_URL}/llms-account.txt

### llms-quickstart.txt — Getting Started & Guides
**Use this when:** User is new to JAW, setting up for the first time, following a tutorial, or building a React Native / Expo app
**Example questions:**
- "How do I get started with JAW?"
- "How do I install JAW?"
- "How do I use JAW in a React Native or Expo app?"
- "How do I implement Sign-In with Ethereum?"
- "How do I set up recurring payments/subscriptions?"
- "What networks does JAW support?"
- "Can you walk me through a basic setup?"
**URL:** ${BASE_URL}/llms-quickstart.txt

### llms-configuration.txt — Configuration Options
**Use this when:** User wants to configure JAW options like gas sponsorship, ENS, or authentication modes
**Example questions:**
- "How do I sponsor gas for my users?"
- "How do I set up gasless transactions?"
- "How do I configure ENS subnames?"
- "What's the difference between crossPlatform and appSpecific mode?"
- "How do I set up a paymaster?"
- "Where do I get an API key?"
**URL:** ${BASE_URL}/llms-configuration.txt

### llms-advanced.txt — Advanced Implementation
**Use this when:** User needs custom UI, self-hosted passkeys, or white-label integration
**Example questions:**
- "How do I build a custom connect UI?"
- "How do I implement app-specific passkeys?"
- "How do I set up my own passkey server?"
- "How do I use ReactUIHandler?"
- "How do I white-label the wallet experience?"
**Package:** \`@jaw.id/core\` + \`@jaw.id/ui\`
**URL:** ${BASE_URL}/llms-advanced.txt

### llms-cli.txt — CLI & AI Agent Integration
**Use this when:** User wants to use JAW from the terminal, shell scripts, or set up MCP for AI agents
**Example questions:**
- "How do I use JAW from the command line?"
- "How do I set up JAW MCP server for Claude?"
- "How do I send a transaction from the terminal?"
- "How do I configure the JAW CLI?"
- "How do I self-host the relay?"
- "How do I use JAW with AI agents?"
**Package:** \`@jaw.id/cli\`
**URL:** ${BASE_URL}/llms-cli.txt

---

## Package Overview

| Package | Use Case | Install |
|---------|----------|---------|
| \`@jaw.id/wagmi\` | React/Next.js apps with Wagmi | \`npm install @jaw.id/wagmi wagmi @tanstack/react-query\` |
| \`@jaw.id/core\` | Non-React or custom provider setups | \`npm install @jaw.id/core\` |
| \`@jaw.id/ui\` | Custom UI for app-specific mode | \`npm install @jaw.id/ui\` |
| \`@jaw.id/cli\` | Terminal, scripts, and AI agents | \`npm install -g @jaw.id/cli\` |

## Quick Links

- **Dashboard (get API key):** https://dashboard.jaw.id
- **Documentation:** https://docs.jaw.id
- **GitHub:** https://github.com/JustaName-id/jaw-mono
- **Developers Chat:** https://t.me/+RsFLPfky7-YxZjVk
`;
}

function generateFullTxt(): string {
  return `# JAW Full Documentation

> This file redirects to the routing index for efficient AI assistance.

For the best experience, please fetch the routing index instead:
→ ${BASE_URL}/llms.txt

The routing index will direct you to the specific documentation file you need based on your question. This approach is more efficient than loading all documentation at once.

## Why Use the Router?

1. **Faster responses** - Only loads the documentation relevant to your question
2. **Better context** - Each domain file is self-contained and focused
3. **More accurate** - AI can provide better answers with focused context

## Direct Links (if you know what you need)

- Wagmi/React integration: ${BASE_URL}/llms-wagmi.txt
- Core provider (EIP-1193): ${BASE_URL}/llms-core.txt
- Account API: ${BASE_URL}/llms-account.txt
- Quickstart & guides: ${BASE_URL}/llms-quickstart.txt
- Configuration: ${BASE_URL}/llms-configuration.txt
- Advanced topics: ${BASE_URL}/llms-advanced.txt
`;
}

async function main() {
  // Resolve served roots at runtime (after vocs build has completed). On Vercel both
  // `.vercel/output/static` and `docs/dist/public` exist; we must write to all of them.
  DIST_DIRS = findDistDirs();
  console.log('Generating llms.txt files to:', DIST_DIRS.join(', '));

  // Pre-compute content once, then write the same output to every served root.
  const domainFiles = Object.entries(DOMAINS).map(([key, domain]) => ({
    key,
    content: generateDomainFile(key, domain),
  }));
  const routingIndex = generateRoutingIndex();
  const fullTxt = generateFullTxt();

  for (const distDir of DIST_DIRS) {
    console.log(`\nWriting to ${distDir}`);

    // Generate domain-specific files
    for (const { key, content } of domainFiles) {
      writeFileSync(join(distDir, `llms-${key}.txt`), content);
      console.log(`  Generated: llms-${key}.txt (${content.length} bytes)`);
    }

    // Generate routing index (overwrites Vocs-generated llms.txt)
    const llmsPath = join(distDir, 'llms.txt');
    writeFileSync(llmsPath, routingIndex);
    console.log(`  Generated: llms.txt (routing index, ${routingIndex.length} bytes)`);

    // Verify the file was written correctly
    const written = readFileSync(llmsPath, 'utf-8');
    if (written.includes('# JAW Documentation')) {
      console.log('  Verified: llms.txt contains custom routing index');
    } else {
      console.error('ERROR: llms.txt does not contain expected content');
      console.error('First 100 chars:', written.slice(0, 100));
    }

    // Generate llms-full.txt (redirects to router - some tools look for this file)
    writeFileSync(join(distDir, 'llms-full.txt'), fullTxt);
    console.log(`  Generated: llms-full.txt (redirect, ${fullTxt.length} bytes)`);
  }

  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
