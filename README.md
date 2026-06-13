# bbb-dmx-utils

Node.js/TypeScript utilities for the `bbb.dmx` JSON ecosystem.

This repo contains import/conversion CLIs plus a local browser editor for
fixture profiles and fixture coordinates. The shared C++ headers, format
documentation, and JSON Schemas live in the `2bbb/bbb-dmx` submodule at
`libs/bbb-dmx`. Max/MSP externals live in `2bbb/bbb.dmx`.

## Commands

- `bbb-dmx-convert` — convert `.gdtf`, `.mvr`, direct GDTF `description.xml`, and compatible MA3 fixture XML into `bbb.dmx` JSON.
- `bbb-dmx-lint` — validate `bbb.dmx` JSON files against schemas and semantic cross-file checks.
- `bbb-dmx-fixture-editor` — start a local Web UI for import, customization, schema validation, and JSON export.

## Development

```sh
git submodule update --init --recursive
npm install
npm run build
npm run smoke
```


## Fixture editor Web UI

`bbb-dmx-fixture-editor` starts a local Node-hosted browser UI for fixture/profile and patch-coordinate editing. It is intentionally local-first: import vendor files, review generated profiles/patches, customize fixture coordinates and JSON, validate/lint against the shared schemas and semantic rules, then download the edited JSON files.

```sh
git submodule update --init --recursive
npm install
npm run build
npm run web -- --port 4173
# open http://127.0.0.1:4173
```

The editor currently supports:

- `.gdtf`, `.mvr`, GDTF `description.xml`, and compatible MA3 XML conversion through the same converter core as `bbb-dmx-convert`.
- profile metadata/key editing, mode channel editing, basic parameter/function reference editing, plus raw profile JSON editing.
- MVR patch fixture editing (`profile`, `mode`, `universe`, `address`, `position`, `rotation`).
- schema validation through `libs/bbb-dmx/schemas`.
- semantic linting for profile/channel references, patch profile/mode references, footprint overflow, duplicate fixture ids, and DMX address overlap.
- per-file JSON download and bulk download.

This is not a lighting-console UI and it does not output DMX. Treat conversion warnings as blockers until checked.

## Examples

```sh
node dist/index.js convert path/to/fixture.gdtf --out-dir converted --overwrite
node dist/index.js convert path/to/scene.mvr --out-dir converted --patch patches/from-mvr.json --overwrite
node dist/index.js convert path/to/ma3-fixture.xml --format ma3 --out-dir converted --overwrite
node dist/lint.js patches/example.json --fixture-dir fixtures --strict
```
