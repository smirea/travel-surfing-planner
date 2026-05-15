# Surfing Trip Project

High level: Find a place that offers daily surfing lessons for 2 weeks in a nice place around the world for 2 complete beginners.

# Requirements

0. daily surfing lessons for complete beginners in english
1. At least 10 days, ideally 2 weeks daily courses
2. Period: after sept 20, 2026 and before end of october
3. Location: anywhere in the world that is (beach weather) in that period. One person is based in Miami, the other in Berlin, so bonus points for locations closer to both of them but look for best fit anywhere in the world
4. Bonus points for a full package service that includes accomodation BUT it's not required
5. Bonus points for really nice locations
6. Bonus points for places that have a lot of other things to do in the area (e.g. closer to a big city and not remote, but again, not a requirement)

# Methodology

The final deliverable will be a `data/result.md` table of `name,country,city,ratings,period,price,with_housing,notes` sorted by desirability given the requirements (price = total per person in USD when a price is known, notes should include meaningful information if needed red/green flags) and a list of `data/[country]__[name-kebab-case].md` files with detailed information (the name of each business is linked to its detailed markdown). The detailed file for each offering should be of the following format:

```md
<!-- google_maps_id: [Google Places placeId, e.g. ChIJ...] -->

# [city, country]: [offering name]

[one meaningful image it]
Duration: ...
Price: ...
Website: ...
Housing: ...
Rating: ...
Things to do around: ...
... other details ...
```

Each per-school detail file must start with the `google_maps_id` HTML comment. Use that Google Places ID as the canonical dedupe key across `data/result.md` and detail files because school names, websites, and Maps URLs can vary. Aggregate markdown files like `data/result.md`, `data/full_evaluation.md`, queue files, and audit files do not represent one school and do not carry a single `google_maps_id`.

1. Find all the countries in the world that have good beach temperature in that period and have access to good surfing places. store the data under `data/queue_countries.md` as a checklist table that you'll work through
   1.1. Take each country one at a time and find business that offer surfing programs for beginners in each of those countries. store the data under `data/queue_country_[country].md` as a checklist table with basic info
2. Perform web searches to find the best surfing business/schools across the world that are available in that period, find at least 100 options, store the data under `data/queue_top-schools.md` as a checklist you'll work through with basic information for each - deduplicate as needed (use `scripts/google-search.ts`)
3. Go through each of the queue files one item at a time, for each business:
   3.1. First validate if it's even offering daily sessions in the desired period, if not mark it as unavailable and move onto the next business
   3.2. If offering is available in the period: inspect its website, it's google maps reviews (use `scripts/google-maps.ts`), look it up on trip advisor and compile a high level summary of the offering in a standardized format, note the reviews and all the other requirements.
   3.3. Compile all the detailed information under `data/[country]__[name-kebab-case].md` in a standardized format and check it as done
