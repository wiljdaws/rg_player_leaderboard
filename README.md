# Rocket Goal — Player Leaderboard

Live competitive rankings for 1v1, 2v2, 3v3, and Wins. Reads the same
`rgleaderboard` Firebase project the ATLAS userscript writes to and renders
per-playlist standings live via `onSnapshot`.

## Structure

```
index.html              page shell
css/leaderboard.css     all styling (design tokens in :root)
js/config.js            Firebase config + playlists + row limit + admin allowlist
js/firebase.js          CDN import, gateway, playlist listener with fallback
js/listener-manager.js  activate/pause/reconnect the visible playlist listener
js/local-cache.js       last-known playlist rows kept in localStorage
js/model.js             sanitize + normalize player docs
js/history.js           per-player MMR history, 60-minute rolling window
js/momentum.js          "last hour" delta per player
js/render.js            podium, recent-gains strip, table, icon key, dialogs
js/admin.js             add/edit/delete forms, icon key management
js/app.js               boot + Firebase listener + tab lifecycle
```

## Recent MMR gains

The site keeps a per-player MMR history in `localStorage` (60-minute rolling
window, one entry per snapshot). The "🔥 last hour" chips and the "Recent MMR
gains" strip are computed from that browser-local history — no schema change to
Firestore. Ported line-for-line from the clan leaderboard.

## Firestore indexes

Only the visible playlist has a live listener. Each listener uses a playlist
filter, descending score order, and a 100-row limit.

Required composite indexes on `leaderboard`:

- `playlist` ascending + `mmr` descending
- `playlist` ascending + `wins` descending

If the index is not ready, the page transparently falls back to a one-time,
scoped read instead of hiding all otherwise valid rows.

## Deploy

No build step. Push to GitHub Pages (or drop into any static host).
