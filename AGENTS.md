# AGENTS

- Keep this project lightweight. Prefer direct Bun scripts over framework setup unless the task really needs more structure.
- Use `yargs` for script argument parsing and keep `.strict()` enabled.
- Use `env-manager` for credentials. Keys live in `.env.local`; regenerate typed access with `env-manager ts src/env.ts --force` after schema changes.
- Use `scripts/google-maps.ts` for Google Maps/Places lookups. It always prints JSON. Run `./scripts/google-maps.ts setup-key` once to create or reuse a restricted Places API key through `gcloud`, save it to `.env.local`, regenerate `src/env.ts`, and sync env-manager storage.
- Common lookup examples:
  - `./scripts/google-maps.ts text "beginner surf lessons Ericeira" --limit 10`
  - `./scripts/google-maps.ts surf-lessons "Ericeira Portugal"`
  - `./scripts/google-maps.ts chargers "33141"`
  - `./scripts/google-maps.ts details places/PLACE_ID --reviews`
