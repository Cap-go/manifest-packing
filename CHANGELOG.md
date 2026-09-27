# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.0.2](https://github.com/Cap-go/manifest-packing/compare/0.0.1...0.0.2) (2026-09-27)

### Features

- implement manifest packing protocol v0 ([12b3b2e](https://github.com/Cap-go/manifest-packing/commit/12b3b2e562b76cb2ce113c9c92a86ca53a30af41))
- **protocol:** split manifest sizes into a bound sidecar ([2567105](https://github.com/Cap-go/manifest-packing/commit/25671057b46b8bdd4c4ed311988e679a6a1c1b7f))

### Bug Fixes

- **bench:** locate v1 decoder allocation checkpoints ([b4d42ef](https://github.com/Cap-go/manifest-packing/commit/b4d42ef2896258d8c4e18a3093dacd20dc73d0a8))
- bound benchmark lifecycle and support corpus scripts on Node 22 ([b8b0994](https://github.com/Cap-go/manifest-packing/commit/b8b099401f78ea8c52c648fbd250c82af7d682ac))
- **protocol:** reject oversized size packets before decoding ([a613151](https://github.com/Cap-go/manifest-packing/commit/a613151d73c7aecf0421a053047365dee1192c0f))
- **release:** enforce canonical semver tag detection ([a4afc13](https://github.com/Cap-go/manifest-packing/commit/a4afc13b5d29dd61f017e8a1d080474895884fba))
- **release:** recognize unprefixed version tags ([16ec749](https://github.com/Cap-go/manifest-packing/commit/16ec749984a6ce88e30d149f755a2f15b797ab39))

## 0.0.1 (2026-09-25)

### Features

- add manifest packing foundation ([3fcc07c](https://github.com/Cap-go/manifest-packing/commit/3fcc07c62e749ea23c8aafd840e252aeedbc92d2))

### Bug Fixes

- align publishing with Capgo release tags ([1579096](https://github.com/Cap-go/manifest-packing/commit/1579096b1a16e8178ce9debc51f7d5194d3a59be))
- use npm staged publishing ([1e1039e](https://github.com/Cap-go/manifest-packing/commit/1e1039e87c4357f7ac26ea0aabbf66d995fd996f))
- use v-prefixed release tags ([f6fc0f3](https://github.com/Cap-go/manifest-packing/commit/f6fc0f3a015b71b78e3bd0763a29cb4c1d878591))
