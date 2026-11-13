# Answer questions about X bookmarks

Query with `unrot x sql "SELECT …"`. It opens `x/bookmarks.db` read-only, prints one JSON object per row and stops after 200 rows; page with `LIMIT` and `OFFSET`.

## Tables

- **`bookmarks_v`**: one row per sorted bookmark. Start here. Columns: `tweet_id`, `sort_index`, `bookmarked_at` (when it was bookmarked, unix seconds), `username`, `url`, `text`, `intent` (the main reason it was saved), `also` (a JSON array of other reasons), `topic`, `title`, `note` (what it is and why it's worth coming back to), `link` (the thing itself, such as a product, repo or article; empty if none).
- **`bookmarks`**: every bookmark, sorted or not. Adds `created_at` (when it was posted), `raw_json`, `first_seen` and `last_seen`.
- **`analysis`**: one row per sorting attempt: `tweet_id`, `status` (ok or error), `error`, `model`, `cost_usd`.

`intent`, `also` and `topic` values are the keys from `unrot lists`. The default reasons are product, design, read, learn, idea and other. The default topics are ai, engineering, design, startups, career, hardware, science, money, life, culture, food_places and fun.

## Examples

```sh
unrot x sql "SELECT title, note, link, url FROM bookmarks_v WHERE intent = 'design' OR also LIKE '%\"design\"%' ORDER BY sort_index DESC LIMIT 20"
unrot x sql "SELECT title, url, date(bookmarked_at, 'unixepoch') AS saved FROM bookmarks_v WHERE topic = 'ai' AND bookmarked_at > strftime('%s', 'now', '-30 days')"
unrot x sql "SELECT title, url FROM bookmarks_v WHERE text LIKE '%sqlite%' OR note LIKE '%sqlite%'"
```

## Caveats

- `bookmarked_at` is exact. `sort_index` prints as a string because it's too large for a JSON number; order by it in SQL.
- Bookmarks the user has since removed on X stay in the database.
- To browse rather than search, point the user to `~/.local/share/unrot/x/lists/bookmarks.html`.
