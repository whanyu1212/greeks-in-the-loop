import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'greeks-in-the-loop',
  description: 'A non-executing options research agent. The agent proposes; deterministic code disposes.',
  base: '/greeks-in-the-loop/',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Overview', link: '/' },
      { text: 'Dry run', link: '/dry-run-research' },
      { text: 'Risk engine', link: '/risk-engine-v1' },
      { text: 'GitHub', link: 'https://github.com/whanyu1212/greeks-in-the-loop' },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [{ text: 'Overview', link: '/' }],
      },
      {
        text: 'Research',
        items: [
          { text: 'Dry-run Research', link: '/dry-run-research' },
          { text: 'Research Source Policy', link: '/research-source-policy' },
        ],
      },
      {
        text: 'The deterministic gate',
        collapsed: false,
        items: [
          { text: 'Risk Engine V1', link: '/risk-engine-v1' },
          { text: 'Trade Intent V2', link: '/trade-intent-v2' },
        ],
      },
      {
        text: 'The trust boundary',
        collapsed: false,
        items: [
          { text: 'Research Decision V2', link: '/research-decision-v2' },
          { text: 'Research Report V3', link: '/research-report-v3' },
        ],
      },
      {
        text: 'Evaluation',
        collapsed: false,
        items: [
          { text: 'Offline Research Evaluation', link: '/research-evaluation' },
          { text: 'Research Behavior Evaluation', link: '/research-behavior-evaluation' },
          { text: 'Deterministic Replay', link: '/backtest-replay-v1' },
        ],
      },
      {
        text: 'Infrastructure',
        collapsed: false,
        items: [
          { text: 'Event Ledger V1', link: '/event-ledger-v1' },
          { text: 'Order Execution V1', link: '/order-execution-v1' },
          { text: 'Observability', link: '/observability' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/whanyu1212/greeks-in-the-loop' },
    ],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/whanyu1212/greeks-in-the-loop/edit/develop/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'The agent proposes; deterministic code disposes. Order submission is application-owned, paper-only, and off by default.',
    },
  },
}))
