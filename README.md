# bbb-dmx-utils

Node.js/TypeScript CLI utilities for the `bbb.dmx` JSON ecosystem.

This repo intentionally contains CLI tooling only. The shared C++ headers,
format documentation, and JSON Schemas live in the `2bbb/bbb-dmx` submodule at
`libs/bbb-dmx`. Max/MSP externals live in `2bbb/bbb.dmx`.

## Commands

- `bbb-dmx-convert` — convert `.gdtf`, `.mvr`, direct GDTF `description.xml`, and compatible MA3 fixture XML into `bbb.dmx` JSON.
- `bbb-dmx-lint` — validate `bbb.dmx` JSON files against schemas and semantic cross-file checks.

## Development

```sh
git submodule update --init --recursive
npm install
npm run build
npm run smoke
```

## Examples

```sh
node dist/index.js convert path/to/fixture.gdtf --out-dir converted --overwrite
node dist/index.js convert path/to/scene.mvr --out-dir converted --patch patches/from-mvr.json --overwrite
node dist/index.js convert path/to/ma3-fixture.xml --format ma3 --out-dir converted --overwrite
node dist/lint.js patches/example.json --fixture-dir fixtures --strict
```
