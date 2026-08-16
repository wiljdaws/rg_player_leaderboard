# Security policy

## Supported versions

Only the site on `main` (GitHub Pages) is supported.

## Report a vulnerability

Do **not** open a public GitHub issue, Discord channel post, or pull request
for a security problem.

Report privately using one of these:

1. [GitHub private vulnerability reporting](https://github.com/wiljdaws/rg_player_leaderboard/security/advisories/new)
2. A private Discord message to Pal or JesusDied4U in the
   [Championship Discord](https://discord.gg/MDz7hsrh9m)

Include the page URL, what you found, and how to reproduce it. Do not include
a public proof-of-concept or steps that let someone else change standings or
access-control lists.

We will acknowledge the report when we see it and tell you when a fix is on
`main`. Please give us time to ship before you talk about it in public.

## What this project is

The public board reads published JSON. Admin Google accounts can edit Access
and Sync. Please do not treat a missing paid-tier Firebase control as a
vulnerability unless it lets a stranger write the allow/ban lists, inject
script into the page, or impersonate an admin.
