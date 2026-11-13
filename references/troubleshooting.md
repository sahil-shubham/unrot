# When a command fails

Find the message below and do what it says. Never retry Instagram in a loop.

| The message mentions | What to do |
|---|---|
| `install the packages once` or `Cannot find package` | Run `bun install --cwd <skill-dir> --frozen-lockfile --production`. |
| `HTTP 429` from `instagram` or `instagram's media server` | Instagram is rate-limiting. Stop, and try again in a few hours. |
| `session expired or challenged`, or `resolve it` | The user opens instagram.com in that browser, logs in or completes the check, then syncs again. |
| `no Instagram login in`, `no x.com login in`, `log into x.com there again`, `X rejected the session` | The user logs in to that site in the browser the message names, or you pass `--browser` for one where they're logged in. |
| `could not read "… Safe Storage" from the keychain` | The keychain prompt was refused or closed. Run it again and have the user click **Allow**. |
| `no Firefox profiles`, `unknown browser`, `no … cookie database` | Pass `--browser` (and `--profile`) for the browser they use, or `--cookies FILE`. |
| `media URL expired` | Instagram's media links expire about a day after a sync. Run `unrot ig sync --full`, then `unrot ig process --retry-errors`. |
| `the web client changed` (X) | x.com changed under the script, so the script or its x-client-transaction-id package needs an update. Nothing to fix locally. |
| `X stopped sending bookmarks before the end of the list` | X ended the walk early. Run `unrot x sync` again later; until one walk reaches the end, every sync walks all bookmarks. |
| `X's image server: HTTP 429` | Wait a while, then run `unrot x process` again. |
| `usage limit reached; it resets around …` | The subscription's limit. Unsorted items stay pending; run `process` again after the reset. |
| `OpenRouter HTTP 401` or `HTTP 402` | The key is wrong or the account is out of credit. `process` stopped and the rest stay pending: fix the key in the data folder's `.env` or add credit, then run `process` again. |
| `OPENROUTER_API_KEY is not set` or `no model access` | Set up a model: [setup.md](setup.md), step 4. |
| `logins found (…) have expired` | Reused Claude or ChatGPT logins are only read, never refreshed. The user opens that app once, or runs `unrot login claude` or `unrot login codex`. |
| `lists.json:` | The message names what to fix in `~/.local/share/unrot/lists.json`. |

Other failures show up under recent errors in `unrot <ig|x> status`; `process --retry-errors` retries those items.
