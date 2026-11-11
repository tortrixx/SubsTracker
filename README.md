# SubsTracker

> 中文版：[README-zh.md](README-zh.md)

**A timed-trigger platform that happens to ship with subscriptions as its first plugin.**

SubsTracker tracks recurring deadlines — today those are your subscriptions — evaluates reminder rules against them every hour, and dispatches notifications through 11 channels. It is built around a simple idea: *everything is a plugin around timed triggers*. Subscription expiry is the first trigger source; scheduled email and task reminders are on the [roadmap](#roadmap).

One TypeScript codebase, two runtimes: deploy the exact same code to **Cloudflare Workers + KV** or to **your own Node server + SQLite**. Storage is a pluggable port, not a hard-coded dependency.

## Features

- **Subscription management** — name, amount, currency, billing cycle (day / month / year, plus lunar cycles), trial flag, categories, payment history, and renewal with preview and undo.
- **Reminder rule engine** — per-subscription rules: *N* days/hours before expiry, on the day, or repeating after expiry. Ships with a preset (7 / 3 / 1 days before + on the day).
- **Editable global default rules** — the preset new subscriptions inherit is a real setting (`DEFAULT_REMINDER_RULES`), editable in the UI. An empty set is a deliberate choice and is honoured as-is.
- **11 notification channels** — Email, Telegram, WeCom (WeChat Work), Bark, NotifyX, ServerChan, PushPlus, ntfy, Gotify, WPush, and a generic Webhook. Per-channel config drawers, enable switches, and one-click send tests that go through the real delivery pipeline.
- **Sending hours** — restrict delivery to chosen hours of the day (in the configured timezone). Empty means *unrestricted*.
- **Logs & health** — every send and every scheduler run is logged and filterable; a health line shows the last tick result on every page.
- **Lunar calendar** — lunar-cycle subscriptions (1900–2100), multi-currency amounts with monthly spend summaries.
- **Dual runtime, pluggable storage** — Cloudflare KV, SQLite (`node:sqlite`), or in-memory, behind one `StoragePort` interface with a conformance check.

## Quick Start

### Option A — Cloudflare Workers

Prerequisites: Node.js, a Cloudflare account, Wrangler (via `npx`).

```bash
npm install
npm run deploy:safe   # creates the KV namespace (scripts/setup-kv.cjs), then deploys
# or, if KV is already set up:
npm run deploy
```

`wrangler.toml` points at `src/index.ts`; Wrangler compiles the TypeScript directly — no pre-build needed. An hourly Cron Trigger drives the scheduler.
The setup script preserves existing `SUBSCRIPTIONS_KV` IDs and other KV bindings; it stops on ambiguous or unsupported configurations.

### Option B — Self-hosted Node server

Prerequisites: **Node.js 24** (the SQLite adapter uses the built-in `node:sqlite`).

```bash
npm install
npm run build         # tsc → dist/ (views and the HTML loader are copied alongside)
npm start             # optionally set PORT / HOST / SQLITE_PATH in the environment
```

For production, a ready-made systemd unit ships in [`deploy/substracker.service`](deploy/substracker.service) (hardened, `Restart=always`, reads `substracker.env`). The Node composition root aligns its scheduler to the top of each hour and exposes `/healthz` for monitoring.

### Option C — Docker Compose

Run `docker compose up -d --build` and open `http://127.0.0.1:3200`. SQLite is stored in the `substracker-data` volume. The default port is bound to localhost; use a reverse proxy and HTTPS for remote access. `docker compose down -v` removes the volume.

### First login

Sign in with the default account **`admin` / `password`**, then change the password immediately under **Settings → Account security**. All channel credentials are configured later in the UI under **Channels** — no secrets live in the repo.

## Configuration

Runtime configuration is stored in the app's own storage and edited in **Settings** (a small set of process-level variables — `PORT`, `HOST`, `STORAGE_DRIVER`, `SQLITE_PATH` — lives in `substracker.env` for the Node runtime). Key items:

| Key | Meaning |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin account. Change the password after first login. |
| `TIMEZONE` | All dates, countdowns and sending hours are interpreted in this zone (e.g. `Asia/Shanghai`). Edited in Settings only — it is the single source of truth for the whole UI. |
| `APP_URL` | Public base URL of this deployment. When set, notification emails include an "open subscription manager" button. |
| `NOTIFICATION_HOURS` | Hours of the day when sending is allowed, e.g. `["08","09","22"]`. **Empty = unrestricted** (every hourly tick may send). Edited on the Channels page. |
| `DEFAULT_REMINDER_RULES` | The rule template applied to newly created subscriptions that don't specify their own rules. `null` (never configured) falls back to the built-in preset (7/3/1 days before + on the day); an empty array means new subscriptions deliberately get **no** rules. |
| `THIRD_PARTY_API_TOKEN` | Token for the third-party trigger API (`/api/thirdparty/notify`). |
| Channel credentials | Per channel, set in the Channels UI: e.g. `RESEND_API_KEY` + `EMAIL_FROM`/`EMAIL_TO` (email), `TG_BOT_TOKEN` + `TG_CHAT_ID` (Telegram), `BARK_DEVICE_KEY`, `SERVERCHAN_SENDKEY`, `PUSHPLUS_TOKEN`, `NTFY_TOPIC`, `GOTIFY_SERVER_URL` + app token, `WECHATBOT_WEBHOOK`, `WEBHOOK_URL`. Values are never committed — they exist only in your deployment's storage. |

Invalid `DEFAULT_REMINDER_RULES` payloads are rejected as a whole (HTTP 400); the previously stored value is kept.

## How Reminders Work

1. **Tick** — once per hour (Workers Cron Trigger, or the Node scheduler aligned to the hour) the scheduler runs.
2. **Evaluate** — each active subscription's reminder rules are evaluated against its (next) expiry date in the configured timezone.
3. **Filter** — if `NOTIFICATION_HOURS` is non-empty and the current hour is not in it, that check skips sending.
4. **Dispatch** — due reminders are sent through every enabled channel. The notification title leads with the most urgent subscription.
5. **Retry** — each channel is deduplicated separately. Failed channels retry only on a later check where the rule still matches and the sending window is open; a single daily window may leave no retry opportunity. Concurrent schedulers on KV cannot guarantee exactly-once delivery.
6. **Log** — sends and scheduler runs land in the Activity page, tagged by origin (scheduled rule, `manual-test`, channel `test`, or `thirdparty`).

Export a backup before upgrading or moving between runtimes. The JSON contains subscriptions, payment history, rules and configuration (secrets optional), but not notification logs, scheduler logs or deduplication state; a matching reminder may be sent again after migration.

## Architecture

Ports-and-adapters: business logic depends only on abstractions; the two entry points are thin composition roots.

- `src/index.ts` — Cloudflare Workers root (KV binding is the storage implementation, zero adapter code).
- `src/server.ts` — Node root (`@hono/node-server`, static views, hour-aligned scheduler, graceful shutdown).
- `src/platform/storage/storage-port.ts` — the `StoragePort` interface (a KV-shaped subset: `get/put/delete/list` + TTL); adapters in the same directory (`sqlite-storage.ts`, `memory-storage.ts`). Verify any adapter with `npm run check:storage`.
- `src/views/` — five pages (Dashboard, Subscriptions, Channels, Activity, Settings) plus `theme-resources.html`, the shared design system and `window.ST` runtime the pages are built on.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Development

```bash
npm run dev            # wrangler dev (Workers runtime)
npm run build          # type-check build → dist/ for the Node runtime
npm test               # vitest suite
npm run lint           # tsc --noEmit (strict)
npm run check:storage  # storage-adapter conformance checks against dist/
npm run check:server   # Node HTTP and static-asset smoke test
npm run check:setup    # KV configuration preservation tests
npm run check:ui       # asynchronous UI state tests
```

TypeScript is `strict` across the repo — no `@ts-ignore`, no implicit `any`. Changes should land with the full suite green.

## Roadmap

SubsTracker is evolving from a subscription notifier into the timed-trigger platform described above, in small, independently shippable steps:

1. **Channel registry** — give all 11 channels manifests and a plugin registry; dispatch resolves channels from the registry. *(planned)*
2. **Kernel split** — separate the scheduler into a trigger kernel (`runTick`) and the subscription plugin's evaluator. *(planned)*
3. **Pipeline promotion** — executors take (event, binding); channel adapters become action plugins. *(planned)*
4. **Schema-driven settings** — channel drawers generated from config schemas. *(planned; today's drawers are the hand-written prototype)*
5. **Scheduled email plugin** — the first declarative trigger source: drafts, send-at scheduling, a `send-mail` action. *(planned)*
6. **Task reminders plugin** — a second declarative source, reusing the offset/rule editor. *(planned)*
7. **Unified activity log** — plugin-origin filtering across all sources. *(optional, last)*

Already in place as groundwork: dual-runtime single codebase, pluggable storage, structured notification payloads, and editable global default rules.

## Credits

Forked from [wangwangit/SubsTracker](https://github.com/wangwangit/SubsTracker). The design language of the v3 UI borrows from Meta's Astryx design system and Craft's glass aesthetic.

## License

[MIT](LICENSE)
