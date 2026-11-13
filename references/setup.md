# Setup (once per machine)

1. **Bun.** Check `bun --version`. If it's missing, point the user to https://bun.sh for the one-line install for their system.
2. **Packages.** Run `bun install --cwd <skill-dir> --frozen-lockfile --production`. The versions are pinned in `bun.lock`. Run it again after the skill is updated.
3. **Browser login.** Before the first sync, explain this to the user in your own words:
   - unrot uses the instagram.com and x.com login already in a desktop browser on this machine. It never sees or asks for a password.
   - It uses the profile Firefox opens when Firefox is installed, otherwise the profile Chrome opened last. For another browser or profile, add `--browser chrome|brave|edge|arc|dia|vivaldi|chromium` and `--profile <folder>` (Chromium browsers work on macOS and Linux), or put `UNROT_BROWSER=…` in the data folder's `.env`. On any system, `--cookies cookies.txt` uses a Netscape cookie export instead.
   - It copies the browser's cookie database to a temporary folder, reads only the cookies for instagram.com or x.com, and deletes the copy. Those cookies are sent only to instagram.com and x.com.
   - With a Chromium browser on macOS, macOS asks once for access to "<Browser> Safe Storage" in the keychain. The user should click **Allow**. **Always Allow** would let any program read that key later without asking.
   - Instagram's and X's terms don't allow automated access. unrot paces itself like someone scrolling, but it's the user's account, so it's their call.
4. **A model.** Both routes below work. Recommend an open model through OpenRouter.
   - **OpenRouter with an open-weight model (recommended).** The user creates a key at openrouter.ai and puts `OPENROUTER_API_KEY=…` in `~/.local/share/unrot/.env`. Settings come only from that file and the shell; a `.env` in whatever project you're working in is ignored. The default, `xiaomi/mimo-v2.6-flash`, is open-weight and does this job well: it watches each reel with its sound. On a library of 3,222 reels it cost about $8 (about $0.0025 a reel), and bookmarks cost about $0.0002 each. Other open models work with `--model` or `UNROT_MODEL`, for example `z-ai/glm-5.3-flash`, which sees images but doesn't hear audio.
   - **The user's Claude or ChatGPT subscription.** If they use Claude Code, Codex CLI, oh-my-pi or pi, unrot reuses that login, and also `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. `unrot models claude` or `unrot models codex` shows which login it picked. Without one, the user runs `unrot login claude` or `unrot login codex` in their own terminal; it opens a browser and waits. These models see 8 frames per reel plus Instagram's captions, not the audio, and they count against the same limits as the user's coding sessions.
   - When an OpenRouter key is set, unrot uses OpenRouter. `--provider claude|codex|openrouter` or `UNROT_PROVIDER` overrides that.
5. **ffmpeg (optional).** Only the Claude and ChatGPT route needs it, to cut reels into frames; without it those models see only the cover image. On macOS: `brew install ffmpeg`.
6. **Next:** tune the sorting to the user before the first sort ([tuning.md](tuning.md)).
