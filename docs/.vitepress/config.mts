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
      { text: 'Strategy', link: '/strategy-v1' },
      { text: 'Risk engine', link: '/risk-engine-v1' },
      { text: 'GitHub', link: 'https://github.com/whanyu1212/greeks-in-the-loop' },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [{ text: 'Overview', link: '/' }],
      },
      {
        text: 'Strategy',
        items: [
          { text: 'Strategy V1', link: '/strategy-v1' },
          { text: 'Pre-Market Research V1', link: '/pre-market-research-v1' },
        ],
      },
      {
        text: 'The deterministic gate',
        collapsed: false,
        items: [
          { text: 'Risk Engine V1', link: '/risk-engine-v1' },
          { text: 'Trade Intent V1', link: '/trade-intent-v1' },
        ],
      },
      {
        text: 'The trust boundary',
        collapsed: false,
        items: [
          { text: 'Research Decision V1', link: '/research-decision-v1' },
          { text: 'Research Report V2', link: '/research-report-v2' },
          { text: 'Research Source Policy', link: '/research-source-policy' },
          { text: 'Research Market Snapshots V1', link: '/research-market-snapshots-v1' },
        ],
      },
      {
        text: 'Evaluation',
        collapsed: false,
        items: [
          { text: 'Offline Research Evaluation', link: '/research-evaluation' },
          { text: 'Research Behavior Evaluation', link: '/research-behavior-evaluation' },
          { text: 'Backtest Replay V1', link: '/backtest-replay-v1' },
        ],
      },
      {
        text: 'Infrastructure',
        collapsed: false,
        items: [
          { text: 'Event Ledger V1', link: '/event-ledger-v1' },
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
      message: 'Non-executing by design. No order-submission code exists in this repository.',
    },
  },
}))
