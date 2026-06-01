# Repd Fitness (PWA)

A personal workout tracker that installs to your iPhone home screen and syncs every
session to a Git repo. Source of truth is the repo; the app keeps a local cache.

## What's inside

```
index.html        app shell + styles
app.js            all logic (var + function-expression style, no nested template literals)
manifest.json     PWA manifest
sw.js             service worker (offline app shell; never caches GitHub API calls)
data/seed.json    your 12-week program preloaded as routines
icons/            app icons
```

The 12-week Push/Pull/Legs/Upper/Lower program is preloaded. Block 1 (all 5 days) and
Block 3 Upper/Lower are taken verbatim from your Obsidian files. Block 2 (all days) and
Block 3 Push/Pull/Legs were generated from your documented scheme (B2: 6-8 compound /
8-12 isolation @ RPE 8; B3: 4-6 / 6-10 @ RPE 8-9) and are tagged "derived" in the Log
tab so you can reconcile them against your vault.

## 1. Put it in a repo

Create a **private** GitHub repo, e.g. `repd`. Two ways to host the app itself:

- **GitHub Pages (simplest):** push these files to the repo, enable Pages on the branch.
  Your app lives at `https://<user>.github.io/repd/`. Note: Pages serves public content;
  the app *code* would be public, but your token stays only on your phone and your
  workout data can live in a *separate private repo* (set the owner/repo in Settings).
- **Any static host / local:** anything that serves the folder over HTTPS works. iOS PWAs
  require HTTPS (or localhost) for service workers.

You can keep the app in one repo and point data sync at another private repo. Recommended:
host the app on Pages, sync data to a private `repd-data` repo.

## 2. Make a GitHub token

GitHub → Settings → Developer settings → **Fine-grained personal access tokens**.
- Repository access: only the data repo.
- Permissions: **Contents: Read and write**.
- Copy the token (starts with `github_pat_`).

## 3. Install on iPhone

1. Open the app URL in **Safari**.
2. Share → **Add to Home Screen**.
3. Open it from the home-screen icon (runs full screen, works offline).

## 4. Configure sync

In the app: **Settings → Git sync**
- Token: paste the fine-grained token
- Owner: your GitHub username
- Repo: the data repo name (e.g. `repd-data`)
- Branch: `main`
- JSON path: `data/workouts.json`
- Logs folder: `logs`

Tap **Save**, then **Test connection**.

## How sync works

- **Rolling state:** `data/workouts.json` is rewritten on every save (one read for the
  current blob SHA, one write). Powers history, PRs, bodyweight, and charts in one read.
- **Session log:** each finished workout also writes `logs/YYYY-MM-DD-<day>.md` in your
  Obsidian Dataview format (frontmatter + `weight x reps @ RPE` set lines). Drop these
  into `Fitness/Logs/` in your vault and Dataview queries work unchanged.
- The blob SHA requirement means a stale device write returns 409 instead of clobbering;
  the app re-reads on next launch via pull-on-startup.

## Notes / caveats

- The token lives in the app's local storage on the phone. Fine for a private single-user
  app; don't publish a build with a token baked in.
- iOS may evict PWA local storage after long inactivity. Because Git is the source of
  truth and the app pulls on launch, your data survives; just keep sync configured.
- Offline: the app opens and logs offline. Saves that can't reach GitHub stay local and
  you can re-push from Settings → Force push.
