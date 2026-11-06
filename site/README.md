# Site

The landing page for the extension. Next.js 15 App Router, hand-written CSS, no UI libraries.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build
```

The version shown on the page is read from the extension's `../package.json` at build time
([lib/version.ts](lib/version.ts)), so it can't drift from the repo.

Deployed on Vercel with **Root Directory = `site`**. Vercel checks out the whole repo, so the
parent `package.json` is there at build time and the page prerenders with the real version baked in.

Design notes: every colour in [app/globals.css](app/globals.css) comes from the facets of
`media/logo.svg`. The one chromatic accent is reserved for live agent state — the running dot and
diff counts — so colour on the page always means "the agent is doing something".
