# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-06-21
- Primary product surfaces: Node-hosted browser fixture/fixture-coordinate editor for `bbb.dmx` JSON.
- Evidence reviewed:
  - `README.md`: CLI utilities currently convert GDTF/MVR/MA3 and lint JSON.
  - `src/index.ts`: conversion logic for `.gdtf`, `.mvr`, GDTF XML, and compatible MA3 XML.
  - `src/lint.ts`: schema and semantic linting surface for generated JSON.
  - `libs/bbb-dmx/docs/*.md`: shared format/spec documentation.

## Brand
- Personality: technical, dense, reliable, show-control oriented.
- Trust signals: visible schema ids, warnings, raw JSON, deterministic export filenames.
- Avoid: toy-looking dashboards, hidden auto-fixes, decorative UI that obscures fixture data.

## Product goals
- Goals:
  - Import GDTF/MVR/MA3-related files and convert them into `bbb.dmx` profiles/patches.
  - Let users customize fixture metadata, channel definitions, and patch coordinates without hand-editing every JSON file.
  - Validate edited data against the shared `bbb-dmx` schemas and semantic lint rules before export.
  - Build setup-era support files, especially `semantic_overrides.json`, with structured controls where valid values can be derived from loaded profiles.
- Non-goals:
  - DMX network output.
  - Full lighting-console replacement.
  - Pixel-perfect visual fixture rendering in the first implementation.
- Success signals:
  - A user can import an MVR, adjust fixture positions/rotations/addresses, validate, and export JSON without touching a terminal.
  - A user can reopen previously converted `bbb.dmx` JSON profiles/patches and continue editing without returning to the original vendor file.
  - Warnings and validation failures are visible and actionable.

## Personas and jobs
- Primary personas:
  - Technical lighting/show-control developer building Max/openFrameworks DMX pipelines.
  - Fixture library maintainer converting vendor data into stable `bbb.dmx` JSON.
- User jobs:
  - Convert third-party fixture/scene data.
  - Inspect and correct generated profile parameters and channel mappings.
  - Tune patch coordinates for mover tracking and fixture placement.
- Key contexts of use:
  - Local development machine, no cloud dependency.
  - Pre-show preparation and debugging, not live busking.

## Information architecture
- Primary navigation: single-page workspace with import, profiles, patch coordinates, validation/export.
- Core routes/screens:
  - `/`: editor workspace.
  - `/api/convert`: import/convert endpoint.
  - `/api/validate`: schema validation endpoint.
  - `/api/health`: server readiness.
- Content hierarchy:
  - Import controls and warnings first.
  - Profile list and selected profile/mode/channel/parameter editor.
  - Patch fixture profile/mode/address/coordinate table.
  - Semantic overrides profile/mode editor:
    - aliases use canonical alias suggestions plus target-parameter selects;
    - intensity uses checkboxes and a primary select;
    - RGB/CMY blocks use role-specific target-parameter selects.
  - Raw JSON and validation/export actions.

## Design principles
- Principle 1: Keep raw JSON visible; never pretend generated fixture data is simpler than it is.
- Principle 2: Forms should edit common fields, while JSON textarea remains the escape hatch.
- Tradeoffs: Dense desktop-first UI is acceptable; mobile optimization is secondary.

## Visual language
- Color: dark neutral background, high-contrast text, amber warnings, red errors, green success.
- Typography: system monospace for JSON/data, system sans for controls.
- Spacing/layout rhythm: compact panels with clear headings and scrollable data regions.
- Shape/radius/elevation: simple bordered cards; no ornamental shadows.
- Motion: minimal; no animation required.
- Imagery/iconography: none required initially.

## Components
- Existing components to reuse: none; no prior frontend in repo.
- New/changed components:
  - File import panel for vendor files and previously converted `bbb.dmx` JSON.
  - Profile selector/editor.
  - Mode channel table.
  - Basic parameter/function reference table.
  - Patch profile/mode/address/coordinate table.
  - Structured semantic_overrides editor with profile/mode selectors, alias rows, intensity checklist, RGB blocks, and CMY blocks.
  - Schema-aware support for setup/groups/matrixmap/semantic_overrides validation.
  - JSON textarea editor.
  - Schema and semantic lint warning/error panel.
  - Download/export controls.
- Variants and states: loading, empty import, conversion warnings, validation errors, success.
- Token/component ownership: local CSS in the generated HTML until the UI grows enough to justify a component system.

## Accessibility
- Target standard: pragmatic WCAG 2.1 AA where feasible.
- Keyboard/focus behavior: all controls must be reachable with native tab order.
- Contrast/readability: dark UI contrast must be sufficient for long JSON editing sessions.
- Screen-reader semantics: use native labels, buttons, tables, and headings.
- Reduced motion and sensory considerations: no essential motion.

## Responsive behavior
- Supported breakpoints/devices: desktop/laptop first; usable on tablets; mobile is best effort.
- Layout adaptations: grid panels collapse to one column on narrow screens.
- Touch/hover differences: no hover-only actions.

## Interaction states
- Loading: disable import button and show status text during conversion/validation.
- Empty: explain accepted input formats and expected flow.
- Error: show endpoint/conversion/schema errors without swallowing details.
- Success: show converted profile count, patch fixture count, and export buttons.
- Disabled: export/validation disabled until data exists.
- Offline/slow network: app is local; network failures should only be local server errors.

## Content voice
- Tone: direct, technical, no marketing copy.
- Terminology: use `profile`, `mode`, `fixture`, `universe`, `address`, `position`, `rotation`, `schema` consistently.
- Microcopy rules: warnings are blockers until checked; do not imply third-party fixture data is trustworthy.

## Implementation constraints
- Framework/styling system: Node built-in HTTP server and plain browser JavaScript for the MVP; avoid bundler debt until needed.
- Design-token constraints: local CSS variables only.
- Performance constraints: handle typical fixture/MVR files locally; do not block UI with unnecessary network calls.
- Compatibility constraints: Node >=20, modern evergreen browsers.
- Test/screenshot expectations: API smoke tests must cover health, convert, schema validation, semantic lint failures, page rendering, and client-script syntax. Visual regression is not required for MVP.

## Open questions
- [ ] Whether to add a 2D/3D coordinate viewport after the data editor stabilizes / owner: project / impact: medium.
- [ ] Whether full range/function editing should become structured UI or remain raw JSON-first / owner: project / impact: medium.
- [ ] Whether setup/groups/matrixmap deserve the same level of structured editing as semantic_overrides or should stay schema/raw-first for now / owner: project / impact: medium.
