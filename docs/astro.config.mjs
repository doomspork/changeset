// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Published as a GitHub project page, so every URL lives under /changeset.
export default defineConfig({
  site: 'https://doomspork.github.io',
  base: '/changeset',
  integrations: [
    starlight({
      title: 'changeset',
      description: 'Validated, constraint-aware writes for TypeScript ORMs.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/doomspork/changeset' }],
      editLink: { baseUrl: 'https://github.com/doomspork/changeset/edit/main/docs/' },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Why changeset', slug: 'guides/why' },
            { label: 'Getting started', slug: 'guides/getting-started' },
            { label: 'Core concepts', slug: 'guides/concepts' }
          ]
        },
        {
          label: 'Guides',
          items: [
            { label: 'Changesets', slug: 'guides/changesets' },
            { label: 'Validators', slug: 'guides/validators' },
            { label: 'Constraints', slug: 'guides/constraints' },
            { label: 'Repos', slug: 'guides/repos' },
            { label: 'Transactions', slug: 'guides/transactions' }
          ]
        },
        {
          label: 'Adapters',
          items: [
            { label: 'Prisma', slug: 'adapters/prisma' },
            { label: 'Memory', slug: 'adapters/memory' },
            { label: 'Writing an adapter', slug: 'adapters/writing' },
            { label: 'Drizzle (planned)', slug: 'adapters/drizzle' }
          ]
        },
        {
          label: 'Examples',
          items: [
            { label: 'Quick start', slug: 'examples/quick-start' },
            { label: 'Multi-tenant app', slug: 'examples/multi-tenant' }
          ]
        }
      ]
    })
  ]
});
