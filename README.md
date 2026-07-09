# worker-cms-plugin-event-action

Event Actions plugin for the Workers CMS — a companion to
[cms-plugin-events](../cms-plugin-events). It adds **repeat actions** over the
events plugin's guest data: each action

1. **selects guests** — a single guest list, or every list of an event,
   narrowed by filters on guest attributes (`status`, `email`,
   `organization`, `checked_in`, …) and guest custom inputs
   (`rsvp_custom_*` keys captured by the RSVP form);
2. **composes a text file** from a LiquidJS template you edit in the admin UI
   (context: `guests`, `event`, `list`, `count`, `now`, `date`; each guest
   exposes `name`, `last_name`, `email`, `phone`, `organization`, `job_title`,
   `status`, `plus_guests`, `checked_in`, `custom.*`, `list_name`, …);
3. **delivers the file** to a webhook (HTTP POST, file as `text/plain` body
   with `content-disposition` / `x-file-name` headers) or by email (Cloudflare
   Email Service, file attached as `.txt`).

Actions run manually ("Run now"), and repeat on a schedule (every 5/15/30
minutes, hourly, daily or weekly at a UTC time) evaluated by the cron trigger.
Each action keeps its last 20 runs as a visible history.

## Architecture

Same two-way wiring as the events plugin:

- **Host → plugin**: the host CMS proxies `/admin/plugins/event-actions/<rest>`
  to this Worker's `/__plugin/admin/<rest>` with `x-plugin-secret` +
  `x-cms-user`; admin pages are client-rendered Liquid views wrapped in the
  host admin chrome.
- **Plugin → host**: reads events / guest lists / guests and stores its own
  `event_action` pages through the host Plugin API (`{CMS_URL}/__cms/*`).
  `event`, `mail_list` and `guest` are declared as `readTypes` — they are owned
  by the events plugin.

## Setup

1. Install and deploy:

   ```sh
   npm install
   npx wrangler secret put PLUGIN_SECRET   # this plugin's secret from the CMS admin
   npm run deploy
   ```

2. Register the plugin on the host CMS (service binding in the host
   `wrangler.toml`, e.g. `PLUGIN_EVENT_ACTIONS = worker-cms-plugin-event-action`,
   and add it to the host's `PLUGINS` list).

3. Optional — email delivery: onboard a sender domain
   (`npx wrangler email sending enable <domain>`), then uncomment the
   `[[send_email]]` binding and `EMAIL_FROM` in `wrangler.toml`.

Local dev: run both `wrangler dev`s; copy `.dev.vars.example` to `.dev.vars`
and make sure `PLUGIN_SECRET` matches the host's (a mismatch 403s every call).

## Development

```sh
npm run typecheck
npm test
```

Tests drive the plugin Worker directly with a stubbed `fetch` standing in for
the host `/__cms/*` API and the outbound webhook — no host required.
