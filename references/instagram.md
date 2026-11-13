# Answer questions about Instagram saves

Query with `unrot ig sql "SELECT …"`. It opens `instagram/reels.db` read-only, prints one JSON object per row and stops after 200 rows; page with `LIMIT` and `OFFSET`.

## Tables

- **`entries_v`**: one row per thing found in a saved post (a film, a restaurant, a product…). Start here. Columns: `category` (the list key), `title`, `kind`, `creator`, `location`, `details`, `confidence`, `url`, `username`, `saved_order`, `summary`, `code`.
- **`media`**: one row per saved post. Columns: `code`, `url`, `username`, `caption`, `taken_at` (when it was posted, unix seconds), `media_type` (1 photo, 2 video, 8 carousel), `product_type` (`clips` is a reel), `saved_order`, `status` (new, analyzed or error), `error`, `raw_json`.
- **`analysis`**: one row per sorted post. Columns: `code`, `summary`, `language`, `transcript`, `on_screen_text`, `model`, `cost_usd`.

`category` values are the Instagram list keys from `unrot lists`. The defaults are ideas, movies_tv, books, food, places, fitness, learning, art_design, products, music, howto and other. Lists in `groupByLocation` (food and places by default) have a city in `location`.

## Examples

```sh
unrot ig sql "SELECT title, location, url FROM entries_v WHERE category = 'food' AND location LIKE '%Lisbon%'"
# "that reel about X": search what was said, shown and written
unrot ig sql "SELECT m.url, a.summary FROM media m JOIN analysis a USING (code) WHERE a.transcript LIKE '%sourdough%' OR a.on_screen_text LIKE '%sourdough%' OR m.caption LIKE '%sourdough%'"
unrot ig sql "SELECT category, COUNT(*) AS n FROM entries_v GROUP BY category ORDER BY n DESC"
```

## Caveats

- Instagram doesn't say when a post was saved. `saved_order` only orders saves (higher means saved later; saving a post again moves it up); `taken_at` is when it was posted.
- `confidence` is nearly always high, so don't filter on it.
- Posts with `status` new or error have no entries yet; `unrot ig status` shows how many there are.
- If a creator deletes a post, its `url` stops working, but the stored caption and summary remain.
