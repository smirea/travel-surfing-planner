# AGENTS

- Keep this project lightweight. Prefer direct Bun scripts over framework setup unless the task really needs more structure.
- Use `yargs` for script argument parsing and keep `.strict()` enabled.
- Use `env-manager` for credentials. Keys live in `.env.local`; regenerate typed access with `env-manager ts src/env.ts --force` after schema changes.
- Use `scripts/google-maps.ts` for Google Maps/Places lookups. It is a launcher for `${process.env.HOME}/code/scripts/src/google-maps.ts`; assume that scripts repo is always present. The shared script prints JSON and expects `GOOGLE_MAPS_API_KEY` from the scripts repo env.
- Common lookup examples:
  - `./scripts/google-maps.ts search "beginner surf lessons Ericeira"`
  - `./scripts/google-maps.ts search "surf school" --near "Ericeira Portugal" --radius 5000 --min-rating 4 --type school`
  - `./scripts/google-maps.ts details places/PLACE_ID --reviews --photos`
  - `./scripts/google-maps.ts details "school name" --near "Ericeira Portugal" --type school --reviews`
