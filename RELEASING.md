# Releasing

How to cut a new version of the Dungeon Cartographer plugin. `.github/workflows/release.yml` only *packages and publishes* a GitHub Release when a tag is pushed — it does not build the plugin, so `main.js` must already be built and committed before tagging.

## Steps

1. Decide the new version number (semver, e.g. `0.1.5`). No `v` prefix — tags and `versions.json` keys are bare numbers (see the existing tags: `0.1.0`–`0.1.4`).
2. Bump `manifest.json`'s `"version"` field to the new number.
3. Add a matching entry to `versions.json`: `"<new version>": "<minAppVersion>"`. Reuse the current `minAppVersion` from `manifest.json` unless this release actually needs a newer Obsidian version, in which case bump both together.
4. Run `npm run build` (runs `tsc -noEmit` then the production esbuild bundle) to regenerate `main.js`. Run `npm test` too, and fix anything broken before proceeding.
5. Commit `manifest.json`, `versions.json`, and the rebuilt `main.js` — plus whatever source changes prompted the release.
6. Tag the commit with the bare version number and push both:
   ```bash
   git tag <new version>
   git push && git push origin <new version>
   ```
7. Pushing the tag triggers `.github/workflows/release.yml`, which creates a GitHub Release and attaches `main.js`, `manifest.json`, `styles.css`, and the `Dungeon Cartographer Settings/` defaults files as downloadable assets, with build-provenance attestation.

## Why `versions.json` matters

Obsidian (and BRAT-style installers) read `versions.json` to work out the oldest plugin version compatible with a given Obsidian install. Every released version needs an entry there, or installers may not offer it to users on older Obsidian builds.

## Picking a version number

No hard rule yet since this plugin isn't on the community store — the pattern so far has been a patch bump (`0.1.x`) per small batch of changes. Bump the minor version instead once a change is big enough to want calling out on its own (a new feature, not a fix/tweak).
