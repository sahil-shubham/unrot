# Tune the sorting to the person

Do this before the first `process`, and whenever the user says the lists don't fit.

Sorting is only as good as the model's idea of why this person saves things. Two optional files in the data folder (`~/.local/share/unrot/`) hold that:

- `about.md`: the user in their own words, included word for word in every prompt. Cover who they are, what they save on Instagram and on X and why, what they'll want to find later, the languages and places in their saves, and what to treat as noise. A short paragraph or a few bullets is plenty.
- `lists.json`: their own lists, for when the defaults don't match why they save. `unrot lists` prints the lists in use as JSON in this file's shape. Any section given here (`instagram.lists`, `instagram.groupByLocation`, `x.intents`, `x.topics`) replaces that section's defaults. Keys are lowercase ids, each list is `["Title", "what belongs on it"]`, and Instagram needs an `other` list.

When neither file exists, set them up with the user:

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
   - Then process the rest ([syncing.md](syncing.md)).

Changing lists after a full run means running `unrot <ig|x> process --redo` and then `export`. The redo re-sorts everything, so it costs credit or subscription quota. Until then, items filed under lists that no longer exist don't appear in any list.
