# unrot

[![skills.sh](https://skills.sh/b/sahil-shubham/unrot)](https://skills.sh/sahil-shubham/unrot)

Saving a reel or bookmarking a post feels like doing something about it. Then it rots in the saved tab.

unrot is an agent skill that pulls those saves in and works out why you saved each one. It files them into lists you can act on: movies to watch, places and restaurants by city, products to try, designs to reuse, things to read. The sorting runs on your Claude or ChatGPT subscription (it reuses the login of Claude Code, Codex CLI, oh-my-pi or pi), or on an OpenRouter key.

```sh
npx skills add sahil-shubham/unrot
```

Then ask your agent something like "unrot my saved reels" or "what restaurants did I save in Lisbon?". It reads [SKILL.md](SKILL.md) and runs `unrot.ts`.

- **One script.** `unrot.ts` runs on [Bun](https://bun.sh) with three packages pinned in `bun.lock`: zod, and x-client-transaction-id with linkedom for X. ffmpeg is optional.
- **Your login, your data.** It uses the instagram.com / x.com session already in your browser. Everything stays in `~/.local/share/unrot`: SQLite, Markdown lists, and an HTML viewer for bookmarks.
- **Tuned to you.** The agent asks what you save and why, then writes `about.md` and, if you want, your own `lists.json`. Both stay in your data folder, never in the skill.

It uses Instagram's and X's private web APIs with your own session, slowly and politely. Use it for your own account.

MIT licensed.
