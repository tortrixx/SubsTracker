# AGENTS.md

Working rules for AI agents and contributors in this repository. These are not
general advice — they encode how this codebase is actually wired and the traps
that have already bitten us.

## Project map

```
src/
  index.ts                 Composition root: Cloudflare Workers
  server.ts                Composition root: Node.js (@hono/node-server)
  app.ts                   The Hono app shared by both runtimes
  api/                     HTTP layer: router.ts, admin.ts, handlers/*
  core/                    Pure domain helpers: time, lunar, currency, auth
  data/                    Repositories + config.ts (DEFAULT_CONFIG lives here)
  platform/storage/        StoragePort interface + sqlite / memory adapters
  platform/node-html-loader.mjs   Lets .html views run under Node
  services/notify/         Channel implementations, dispatch, reminder engine
  services/scheduler.ts    The hourly tick
  views/                   Five pages + theme-resources.html (shared layer)
deploy/                    systemd unit + env example (Node runtime)
docs/ARCHITECTURE.md       Architecture notes
```

The five views are `dashboardPage.html`, `adminPage.html` (subscriptions),
`channelsPage.html`, `notifyLogsPage.html` (activity), `configPage.html`
(settings), plus `loginPage.html`. All of them are built on
`theme-resources.html`: design tokens (`.st-*` components) and the `window.ST`
runtime (`ST.loadConfig`, `ST.daysDiff`, `ST.health`, `ST.CHANNELS`, …).
`src/views/pages.ts` injects the shared layer into each page at render time.

## Hard invariants

1. **One codebase, two runtimes.** Core logic must never import a runtime API
   (no `caches`, no `process.env`, no `node:*`) outside the composition roots
   (`src/index.ts`, `src/server.ts`) and `src/platform/`. If a feature needs
   runtime behaviour, define a port and wire it in both roots.
2. **Storage goes through `StoragePort`** (`src/platform/storage/storage-port.ts`,
   a KV-shaped subset: `get/put/delete/list`, `expirationTtl`). Business code
   receives the port via `env.SUBSCRIPTIONS_KV` and must not know whether the
   backing store is Cloudflare KV, SQLite, or memory.
3. **TypeScript `strict`, no exceptions.** No `@ts-ignore`, no `@ts-expect-error`
   without a written reason, no implicit `any`. `npx tsc --noEmit` must stay at
   zero errors.
4. **Views are runtime-agnostic.** The same `.html` files run under Wrangler
   (text imports) and Node (the HTML loader). Don't put runtime-specific code
   in a view.

## Known traps — read before touching these areas

- **Config saves rebuild the object field by field.** `POST /api/config`
  reconstructs the stored config explicitly. A new config key therefore needs
  **three** coordinated edits: `DEFAULT_CONFIG` in `src/data/config.ts`, the
  read/write handling in `src/api/handlers/config.ts`, and confirmation that
  `buildSafeConfig` passes it through (secrets don't). Add the key in only one
  place and saving settings will silently drop it.
- **`pages.ts` injects `theme-resources.html` with `String.replace`.** Literal
  `$` sequences in the replacement string (`$'`, `$$`, `$&`) are interpreted
  as substitution patterns and will corrupt the page. In shared-layer code,
  never emit a bare `$` followed by `'`/`` ` ``/`&`/`$` — write the dollar sign
  as `\u0024` in JS strings.
- **`NOTIFICATION_HOURS` empty means unrestricted.** An empty array is a
  deliberate state ("send on any tick"), on the backend (scheduler) **and** in
  the channels-page picker. Any normalization must map "nothing selected" to
  `[]`, never to a partially-filled default, and the two sides must agree.
- **Default rules are templates, not shared objects.** When
  `resolveDefaultRules` (in `src/data/reminders.repo.ts`) instantiates
  `DEFAULT_REMINDER_RULES` for a new subscription, rule `id` and `createdAt`
  must be regenerated per subscription. Copying them verbatim creates
  cross-subscription ID collisions. `null` config = never configured → built-in
  preset (7/3/1 days + day-of); `[]` = configured-empty → no rules. Manual
  renewal never applies defaults.
- **Rule validation has exactly one source of truth:** `validateReminderRules`
  in `src/data/reminders.repo.ts` (field domains mirror `normalizeRule`).
  Don't re-implement checks in handlers or views; call it. One invalid rule
  rejects the whole payload.
- **Notification-log `ruleId` is a source tag.** Real sends carry the real
  rule ID; subscription manual tests use `'manual-test'`; channel send-tests
  use `'test'` (and must be logged — see `src/api/handlers/test-notification.ts`);
  third-party API sends use `'thirdparty'`. The activity page and channel cards
  distinguish origins by this field; inventing a new spelling breaks filters.
- **The app version is a hard-coded constant,** `VERSION` in
  `src/api/handlers/extras.ts` (served at `/api/version`, shown in the UI).
  `package.json`'s `version` is metadata only. Bump both together or neither.
- **`package.json` name stays `subscription-manager`.** It is referenced by
  `wrangler.toml` / `wrangler.dev.toml` (Worker names) and `package-lock.json`.
  Renaming the package without renaming the Workers breaks deploys.

## Workflow

After any change, all three must pass:

```bash
npm test               # vitest — currently 279 tests, all green
npx tsc --noEmit       # strict type check, 0 errors
npm run build          # production build → dist/
```

When touching storage code, also run `npm run check:storage` (conformance
assertions run against the built `dist/`, i.e. the artifact that ships).
When touching views, verify both themes in a real browser — the light/dark
token layers have bitten us before (a legacy `!important` body-background rule
once pinned dark pages to a light background, and `display:flex` component
classes override the `hidden` attribute; use explicit `[hidden]` guards or
`style.display` toggles).

## Commit conventions

Follow the existing `git log` style: a Chinese one-line summary, then a
hyphenated bullet list of the concrete changes (files/mechanisms, not vibes).
One logical change per commit. Docs-only changes say so in the summary.

## Prohibitions

- Never commit `data/`, `dist/`, `node_modules/`, `*.sqlite*`, `.env` files, or
  any credential (channel tokens, API keys, JWT secrets). Config values belong
  in deployment storage, not in the repo.
- Do not edit the `LICENSE` attribution.
- Do not push to the upstream repository (`wangwangit/SubsTracker`); this fork
  lives at `tortrixx/SubsTracker`. Upstream is a read-only reference.
- Do not "fix" view glitches by editing the built files in `dist/` — fix the
  source in `src/views/` and rebuild.
