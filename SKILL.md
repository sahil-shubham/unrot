---
name: unrot
description: "Turn the Instagram reels/posts and X (Twitter) bookmarks the user saved and never went back to into lists they can use (movies, books, food, places, ideas, products, designs, things to read...), sorted by their Claude Pro/Max or ChatGPT subscription or OpenRouter. Use to sync or sort saves, answer 'what did I save about X', 'that reel/tweet about Y', or list saved movies/restaurants/products/designs."
---

# unrot

Saving a reel or bookmarking a post feels like doing something about it. Then it rots in the saved tab. unrot pulls those saves in, has a model work out why each one was saved, and files them into lists the user can actually act on.

It's one Bun script, `unrot.ts` in this skill's folder, plus three npm packages pinned in `bun.lock`: zod, and x-client-transaction-id with linkedom for X. It uses the user's own browser login, keeps everything in SQLite, and writes the lists as Markdown files.

```
browser login ─► sync ─► SQLite (raw API JSON) ─► process (1 model call per item) ─► export ─► Markdown lists (+ HTML viewer for X)
```

Run every command as `bun <skill-dir>/unrot.ts …`. Below, `unrot` stands for that.

## Setup (once)

1. **Bun**: check with `bun --version`. If it's missing, install it with `curl -fsSL https://bun.sh/install | bash`.
2. **Packages**: run `bun install --cwd <skill-dir> --frozen-lockfile --production` once, and again after updating the skill. Without it the script stops with that command, or Bun reports "Cannot find package".
3. **Browser login**: the user must be logged into instagram.com and/or x.com in a desktop browser on this machine. Firefox is used when it's installed. Otherwise:
   - pass `--browser chrome|brave|edge|arc|dia|vivaldi|chromium` (macOS and Linux; macOS asks once for keychain access), or
   - pass `--cookies cookies.txt` (a Netscape cookie export; works anywhere).
4. **Model access**: usually nothing to do.
   - If the user is logged into a Claude or ChatGPT subscription in **Claude Code, Codex CLI, oh-my-pi or pi**, the script reuses that login. It also reuses `CLAUDE_CODE_OAUTH_TOKEN` (made by `claude setup-token`).
   - Run `unrot models claude` or `unrot models codex` to check. It prints which login it picked.
   - Borrowed logins are only read, never refreshed: a refresh would give the other app a new refresh token and sign it out. They stay fresh as long as the user keeps using that app. If they've all expired, the error names them; have the user open one of those apps once, or use `unrot login`.
   - Subscription runs use the same usage limits as the user's coding sessions.

   If there's no login to reuse, use one of these:
   - `unrot login claude` (Claude Pro/Max) or `unrot login codex` (ChatGPT Plus/Pro/Business). It opens a browser for OAuth and waits for the redirect, so **ask the user to run it in their own terminal**. On a remote machine they can approve in any browser and paste the URL it lands on. Tokens go to `~/.local/share/unrot/auth.json` (mode 600) and refresh automatically.
   - `OPENROUTER_API_KEY=...` in `~/.local/share/unrot/.env`: pay per use, about $0.0025 per reel and $0.0002 per bookmark.
5. **ffmpeg** (optional, `brew install ffmpeg`): with Claude or Codex, each reel's video is sent as 8 frames. Without ffmpeg, only its cover image is sent.

## Tune it to the person (before the first `process`)

Sorting is only as good as the model's idea of why this person saves things. Two optional files in the data folder hold that:

- `about.md`: the user in their own words, included word for word in every prompt. Cover who they are, what they save on Instagram and on X and why, what they'll want to find later, the languages and places in their saves, and what to treat as noise. A short paragraph or a few bullets is plenty.
- `lists.json`: their own lists, for when the defaults don't match why they save. `unrot lists` prints the lists in use as JSON in this file's shape. Any section given here (`instagram.lists`, `instagram.groupByLocation`, `x.intents`, `x.topics`) replaces that section's defaults. Keys are lowercase ids, each list is `["Title", "what belongs on it"]`, and Instagram needs an `other` list.

Both files belong to the user and never go into this skill folder. Edits to `unrot.ts` would be overwritten by the next update, and nothing personal should ship with the skill.

When neither file exists, set them up with the user before sorting:

1. Ask a few short questions:
   - What do they save on each site, and why?
   - What will they want to find later (restaurants by city, gift ideas, job posts, UI to copy)?
   - What languages are their saves in?
   - What do they not care about?
2. Write `about.md` from their answers, in their words, and show it to them.
3. Run `unrot lists`. If their reasons don't fit the defaults, write `lists.json` with only the sections that change, and confirm it with them.
4. Calibrate on a sample:
   - Run `unrot <ig|x> process --limit 20`, then `unrot <ig|x> export`, and show them where things landed.
   - Adjust the files and re-run with `--redo --limit 20` until it looks right.
   - Then process the rest.

Changing lists after a full run means running `unrot <ig|x> process --redo` and then `export`. The redo re-sorts everything, so it costs quota or credit. Until then, entries filed under lists that no longer exist don't appear in any list.

## Commands

| Command | What it does |
|---|---|
| `unrot ig run` / `unrot x run` | sync new saves, sort them, rewrite the lists |
| `unrot ig status` / `unrot x status` | counts, models used, spend, recent errors |
| `unrot <ig\|x> sync [--full]` | fetch saves; `--full` walks everything (see below for where a normal sync stops) |
| `unrot <ig\|x> process [--limit N] [--workers N] [--retry-errors] [--redo] [--provider P] [--model M]` | sort unsorted items |
| `unrot <ig\|x> export` | rewrite the lists from the database |
| `unrot models <claude\|codex>` | models the subscription can use, and which login is used |
| `unrot lists` | the lists in use (defaults plus the user's `lists.json`), as JSON |
| `unrot <ig\|x> cookies-export FILE` | write cookies.txt, to run on another machine with `--cookies FILE` |

A normal Instagram sync stops at the first page it already has; a normal X sync stops after 50 known bookmarks in a row.

The first X sync walks all bookmarks, about 2 s per 50. The first Instagram sync walks the whole saved feed at 15 to 30 s per page of 50, so 3,000 saves take about 20 minutes. Run long jobs detached: `nohup bun unrot.ts ig run > ~/.local/share/unrot/ig.log 2>&1 &`.

**Provider choice**: the script uses `--provider` if given, then `UNROT_PROVIDER`. Otherwise it uses OpenRouter if a key is set, else whichever subscription is logged in. Default models: `claude-haiku-5-5`, `gpt-6-luna`, `xiaomi/mimo-v2.6-flash`.

Only OpenRouter models that take video, like the default, hear a reel's speech. Claude and Codex see frames, plus Instagram's auto-captions when the reel has them (about 1 in 6 reels). Talking-head reels without burned-in captions lose detail.

**Usage limits**: on a subscription limit (an HTTP 429 that clears later than 2 minutes), `process` stops and says when the limit resets. Unprocessed items stay pending; run it again later. Subscription runs default to 4 workers.

## Data: `~/.local/share/unrot/` (override with `UNROT_HOME`)

- `instagram/reels.db`:
  - `media`: one row per saved post, with `raw_json` and `status` (new | analyzed | error).
  - `analysis`: summary, transcript, on_screen_text, model, cost_usd.
  - `entries`: one row per thing found.
  - The view `entries_v` has category, title, kind, creator, location, details, confidence, url, username, saved_order, summary, code.
- `instagram/lists/*.md`: one file per list, newest first. Lists in `groupByLocation` (food and places by default) are grouped by city.
- `x/bookmarks.db`:
  - `bookmarks`: tweet_id, sort_index, bookmarked_at, created_at, username, text, url, raw_json.
  - `analysis`: intent, `also` (a JSON array), topic, title, note, link, model.
  - The view `bookmarks_v` joins the sorted ones.
- `x/lists/bookmarks.html`: a viewer with a tab per reason, topic chips, search and "mark done".
- `x/lists/*.md`: one file per reason.

The databases are the source of truth; the lists are regenerated from them. Answer questions with `sqlite3`:

```sh
cd ~/.local/share/unrot
sqlite3 -header -column instagram/reels.db "SELECT title, location, url FROM entries_v WHERE category='food' AND location LIKE '%Lisbon%'"
# "that reel about X": search what was said, shown and written
sqlite3 instagram/reels.db "SELECT m.url, a.summary FROM media m JOIN analysis a USING (code) WHERE a.transcript LIKE '%sourdough%' OR a.on_screen_text LIKE '%sourdough%' OR m.caption LIKE '%sourdough%'"
sqlite3 -header -column x/bookmarks.db "SELECT title, note, link, url FROM bookmarks_v WHERE intent='design' OR also LIKE '%\"design\"%' ORDER BY sort_index DESC LIMIT 20"
```

List keys are whatever `unrot lists` shows. The defaults:

- Instagram lists: ideas, movies_tv, books, food, places, fitness, learning, art_design, products, music, howto, other.
- X reasons: product, design, read, learn, idea, other.
- X topics: ai, engineering, design, startups, career, hardware, science, money, life, culture, food_places, fun.

When answering:

- Always cite the post `url`.
- Instagram doesn't expose when a post was saved; `saved_order` only orders saves. X's `bookmarked_at` is exact.

Other `.env` keys: `UNROT_PROVIDER`, `UNROT_MODEL`, `UNROT_BROWSER`.

## Rules

- These are private web APIs used with the user's own session. **Never lower the Instagram delays, add retry loops or run two syncs at once.**
- Instagram stops on HTTP 429 or a login challenge. Tell the user to wait a few hours, or to resolve the challenge on instagram.com. X waits out its rate limit by itself.
- "session expired" or a login redirect means the user has to log in again in that browser.
- "media URL expired" means the Instagram CDN links went stale (they last about a day after a sync). Run `unrot ig sync --full`, then `unrot ig process --retry-errors`.
- Downloaded media is deleted after each post is analysed unless you pass `--keep-media`. A video is about 7 MB.
- "the web client changed" from X means x.com changed its web client underneath the script, and `unrot.ts` or its x-client-transaction-id package needs updating.
