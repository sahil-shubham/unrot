# Fetch and sort saves

`unrot ig run` and `unrot x run` do the whole job: fetch new saves, sort them, and rewrite the lists. The individual steps:

| Command | What it does |
|---|---|
| `unrot <ig\|x> sync [--full]` | Fetch saves. A normal sync stops once it has caught up: Instagram at the first page it already has, X after 50 known bookmarks in a row. `--full` walks everything; on Instagram it also refreshes expired media links. |
| `unrot <ig\|x> process [--limit N] [--workers N] [--retry-errors] [--redo] [--provider P] [--model M]` | Sort items that haven't been sorted. `--retry-errors` retries failed ones; `--redo` re-sorts everything, which costs credit or quota. |
| `unrot <ig\|x> export` | Rewrite the lists from the database. |
| `unrot <ig\|x> status` | Counts, models used, spend, recent errors. |
| `unrot lists` | The lists in use, as JSON. |
| `unrot <ig\|x> cookies-export FILE` | Save the browser's cookies for that site to FILE, to sync on another machine with `--cookies FILE`. |

## Where the lists are

- `~/.local/share/unrot/instagram/lists/*.md`: one file per list, newest saves first. Food and places are grouped by city.
- `~/.local/share/unrot/x/lists/*.md`: one file per reason.
- `~/.local/share/unrot/x/lists/bookmarks.html`: a viewer with a tab per reason, topic chips, search and "mark done". The user opens it in a browser.

## How long it takes

- The first X sync walks every bookmark, about 2 s per 50.
- The first Instagram sync walks the whole saved feed at 15 to 30 s per page of 50, so 3,000 saves take about 20 minutes.
- Sorting runs several items at once: 16 workers for Instagram and 12 for X with OpenRouter, 4 with a subscription. About 30 reels a minute with OpenRouter.

Run long jobs detached and check on them with `status`:

```sh
nohup bun <skill-dir>/scripts/unrot.ts ig run > ~/.local/share/unrot/ig.log 2>&1 &
```

## Good to know

- On a subscription usage limit, `process` stops and says when the limit resets. Unsorted items stay pending; run it again after the reset.
- Downloaded media is deleted after each post is sorted, unless you pass `--keep-media`. A video is about 7 MB.
