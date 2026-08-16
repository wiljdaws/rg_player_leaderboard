# Rocket Goal — Player Leaderboard

Live 1v1, 2v2, 3v3, and Wins standings for the Rocket Goal community. ATLAS
writes match results; this site publishes them.

**[Open the board](https://wiljdaws.github.io/rg_player_leaderboard/)**
· [Clan Clash](https://wiljdaws.github.io/RG_Clan_Leaderboard/)
· [Install ATLAS](https://github.com/wiljdaws/Tampermonkeys)
· [Discord](https://discord.gg/MDz7hsrh9m)

Visitors read published JSON. They do not list Firestore. Admins sign in with
Google for Sync and Access (allow list, ban list, device bans).

## How it works

1. ATLAS writes a player's row after a match.
2. The publisher in [Tampermonkeys](https://github.com/wiljdaws/Tampermonkeys)
   writes JSON to the `data` branch.
3. This site renders that JSON on GitHub Pages.

Recent MMR chips and the “last hour” strip are computed in the browser from
`localStorage`. They are not a second Firestore feed.

## Local setup

```bash
npm start   # http://localhost:5173
npm test
```

No build step. Push to `main` and GitHub Pages updates.

## Layout

```
index.html              page shell
privacy.html            privacy policy
terms.html              terms of use
css/leaderboard.css     design tokens and layout
js/app.js               boot, tabs, admin actions
js/access-view.js       allow / ban / device lists
js/firebase.js          auth, published JSON, admin writes
js/render.js            podium, table, dialogs
js/model.js             sanitize player rows
js/history.js           60-minute local MMR window
js/momentum.js          last-hour delta
```

## Related

- [ATLAS HUD](https://github.com/wiljdaws/Tampermonkeys)
- [Clan Clash Cup](https://github.com/wiljdaws/RG_Clan_Leaderboard)

## Community

This is a fan project. It is not affiliated with Rocket Goal.

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [MIT License](LICENSE)
- [Privacy](https://wiljdaws.github.io/rg_player_leaderboard/privacy.html)
- [Terms](https://wiljdaws.github.io/rg_player_leaderboard/terms.html)
