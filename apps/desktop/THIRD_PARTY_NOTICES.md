# Voice and global shortcut dependencies

The macOS package contains available full notices, package metadata, model hashes and native-addon sources in `Contents/Resources/licenses`. The application license does not replace dependency, model, or imported character licenses. Existing Live2D notices are in `renderer/src/live2d/`. This inventory is not a certification of redistribution compliance.

## uiohook-napi 1.5.5

- Wrapper: MIT, Copyright (c) 2020 Alexander Drozdov. Full notice: `node_modules/uiohook-napi/LICENSE`.
- Source: https://github.com/SnosMe/uiohook-napi
- Bundled native libuiohook: LGPL-3.0-or-later, Copyright (C) 2006-2023 Alexander Barker, as stated in the installed `libuiohook/include/uiohook.h` and source headers.
- Native source: https://github.com/kwhat/libuiohook
- License: https://www.gnu.org/licenses/lgpl-3.0.html

Redistribution must satisfy the applicable full notices, license texts and corresponding-source / relinking requirements for the native addon. Retain the exact bundled revision, not just a link to a moving upstream branch. The package includes the installed 1.5.5 sources, binding.gyp and rebuild notes; these do not independently certify exact prebuilt-binary provenance or LGPL compliance.

The hook is loaded only after the user opts in and grants the required OS permission. The application consumes shortcut key events, not typed text, and does not store a keyboard event log.

## partial-json-parser 0.2.1.1.post7

- MIT, as declared in the installed Python package metadata and license file.
- Source: https://github.com/promplate/partial-json-parser
- Used by the Python API to extract incremental companion text from partial structured model output.

## Existing voice runtime

The frozen local service uses CPython 3.12.15 or a newer 3.12 security patch. Its original runtime license and Python/OpenSSL version record accompany the package under `licenses/python/CPython`. Python packages retain their own full notices and metadata under `licenses/python`.

Markdown-to-text conversion uses Marked 18.1.0 (MIT): https://github.com/markedjs/marked. Full license: `node_modules/marked/LICENSE`. The application consumes its lexer tokens as text and never injects generated HTML into the companion bubble.

Silero VAD assets, ONNX Runtime, sherpa-onnx and downloaded voice model weights retain their respective notices and licenses. Downloading weights or importing a character does not grant redistribution permission. Audit the exact files and include their notices before public release.
