# Contributing to the player leaderboard

This is the public Rocket Goal player board. Visitors read published JSON.
Admins sign in with Google for Sync and Access.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Talk first on bigger changes

Open an issue or ping Pal / JesusDied4U in the
[Championship Discord](https://discord.gg/MDz7hsrh9m) before you:

- Put the public standings back on a live Firestore `list` or `onSnapshot`
- Add admin tabs that scan Firestore
- Change allow-list / ban-list writes
- Change how the publisher JSON is consumed

UI fixes, tests, and docs are fine as a pull request.

## Hard limits

The board shares the Firebase **Spark** free plan with ATLAS (50k reads /
20k writes a day). Quota outages take the HUD down too.

Do not:

- Add `getDocs` / collection scans for visitors
- Look up `script_submissions` on every Access refresh
- Commit `.cursor/`, secrets, or service-account JSON
- Enable App Check

Name lookups on Access are JSON + local cache first. Only brand-new allow/ban
uids may hit Firestore, and only a handful per pass.

## How to work

1. Fork the repo and branch from `main`.
2. Serve locally with `npm start` (port 5173).
3. Run `npm test` before you open a pull request.
4. Push to `main` only through a reviewed PR unless you are a maintainer
   shipping a hotfix.

GitHub Pages serves `main`. A cache-bust `?v=` query is bumped by the
pre-commit hook when assets change.

## Related repos

- ATLAS HUD: [wiljdaws/Tampermonkeys](https://github.com/wiljdaws/Tampermonkeys)
- Clan Clash site: [wiljdaws/RG_Clan_Leaderboard](https://github.com/wiljdaws/RG_Clan_Leaderboard)

## Security

Do not file a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
