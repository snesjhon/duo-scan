# duo-scan

A Cloudflare Worker that checks Apple Store pickup availability for the
**iPhone Duo 256GB Black, unlocked** every minute, across stores within about
2 hours of 95831. When one has stock, it sends an urgent push notification to
your phone through the free [ntfy](https://ntfy.sh) app. Tap the notification
to open Apple's page and reserve.

## Setup (from an iPhone)

1. **ntfy:** install **ntfy** from the App Store, tap **+**, and subscribe to
   the topic `duo-scan-1456e0f7a6e496c6` (server: ntfy.sh). Allow notifications.
2. **Cloudflare:** sign up at dash.cloudflare.com, then go to **Workers &
   Pages → Create → Import a repository**, connect GitHub, pick `duo-scan`,
   and deploy. Every push to `main` redeploys on its own.
3. **Test:** open `https://duo-scan.<your-subdomain>.workers.dev/test`. You
   should get a test notification.

## Useful URLs

| Path      | What it does                                   |
|-----------|------------------------------------------------|
| `/status` | Result of the last check (stores, errors)      |
| `/check`  | Run a check right now                          |
| `/test`   | Send a test notification                       |
| `/parts`  | Part numbers found on Apple's iPhone Duo page  |

## Notifications you'll get

- **"iPhone Duo AVAILABLE for pickup!"**: store, distance, tap to reserve.
  Repeats every 3 minutes while it's still in stock.
- **"duo-scan can't check Apple"**: 10 checks in a row failed (e.g. Apple
  is blocking requests). **"duo-scan is working again"** when it recovers.
- **"duo-scan is watching"**: a quiet once-a-day ping (9am Pacific) so you
  know it's alive.

## Changing what it looks for

Everything is in `wrangler.toml` under `[vars]`: model, ZIPs, distance. If
Apple's page changes and part numbers can't be found automatically, put them
in `PART_NUMBERS`.

## Tests

`npm test` runs offline tests with fake Apple responses.
