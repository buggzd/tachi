# Third-Party Notices

## RayNeo hardware protocol references

The application controls the verified Air 3s USB display interface directly
through Android USB Host APIs. It does not load, bundle or bind to the RayNeo
Air SDK or XR Space application.

- Documentation: <https://rayneo.gitbook.io/rayneo-devdoc/>
- Historical SDK reference: the pinned download in `scripts/install-rayneo-sdk.sh`
- Protocol analysis and scope: [SBS geometry and USB scope](docs/SBS_GEOMETRY.md#usb-模式控制)

RayNeo vendor binaries are not redistributed in this repository or included in the
current APK. The historical SDK download helper remains for reproducible
analysis and is not required by the build.

## Web application dependencies

The embedded frontends use open-source packages recorded in their npm lockfiles,
including:

- React and React DOM — MIT License
- Vite and `@vitejs/plugin-react` — MIT License
- hls.js — Apache License 2.0
- libass-wasm 4.1.0 — JavascriptSubtitlesOctopus/libass and its font/shaping dependencies; see below
- Lucide React — ISC License
- TypeScript — Apache License 2.0

Transitive packages and exact resolved versions are listed in
`GlassesUI/package-lock.json` and `CompanionUI/package-lock.json`.

## Android image metadata

AndroidX ExifInterface 1.4.2 — Apache License 2.0 — is used to preserve the
orientation of imported phone backgrounds. The saved JPEG is resized and
re-encoded without the original metadata.

- Source and license: <https://android.googlesource.com/platform/frameworks/support/+/androidx-main/exifinterface/>
- Apache License: <https://www.apache.org/licenses/LICENSE-2.0>

The license text is bundled in `CompanionUI/public/licenses/Apache-2.0.txt`.
AndroidX annotations and the other transitive dependencies retain their original licenses.

## Native playback laboratory

The separate native playback laboratory uses AndroidX Media3 ExoPlayer and its
HLS module, version 1.5.1, under the Apache License 2.0. These modules are not yet
dependencies of the shipping application.

- Source and license: <https://github.com/androidx/media/tree/1.5.1>
- Apache License: <https://www.apache.org/licenses/LICENSE-2.0>

## Optional QNN depth runtime

The opt-in realtime and native QNN laboratory builds use the local artifacts
pinned by `AndroidApp/realtime-sbs-runtime.json`; these binaries are not tracked.

- ONNX Runtime 1.22.0 / QNN execution provider — MIT — <https://github.com/microsoft/onnxruntime>
- Depth Anything V2 Small upstream model — Apache License 2.0 — <https://github.com/DepthAnything/Depth-Anything-V2>
- Qualcomm QAIRT/QNN runtime — Qualcomm SDK terms accepted during local SDK installation.
  The model and runtime hashes identify the validated quantized deployment artifacts.

Full APKs bundle the runtime as part of the application, not as a standalone SDK.
QAIRT LICENSE.pdf, NOTICE.txt and QNN_NOTICE.txt are copied unchanged from the
locally installed SDK into assets/realtime-sbs/licenses/qairt. ONNX Runtime MIT
and third-party notices from v1.22.0 are included alongside the Apache-2.0 text
and this attribution file. Local depth models are converted and quantized from
the upstream Small model; their hashes do not establish redistribution rights.
Before publishing a separate model asset, verify the exact source and conversion
artifact terms. Neither the full SDK nor standalone QNN libraries/dependency ZIPs
are published. GitHub Actions builds Lite without these dependencies.

## Jellyfin

Jellyfin names and trademarks belong to their respective owners. This
third-party client communicates with Jellyfin through its public API and does
not redistribute Jellyfin server software.

## RayNeo product image

`CompanionUI/public/art/rayneo-air-3s.webp` is cropped and resized from the
RayNeo Air 3S official product artwork supplied by the user. It preserves the
product's original appearance and transparency. The product artwork and RayNeo
marks remain the property of their respective owners and are not covered by
this repository's MIT license.

## Local ASS subtitle rendering

`libass-wasm` 4.1.0 supplies the WebAssembly renderer and worker for ASS/SSA.
Its original worker source is wrapped with local blob resource resolution; the
WASM binary is unchanged. `GlassesUI/src/assRenderer.ts` supplies canvas drawing,
resource limits and cleanup. No remote renderer or font CDN is loaded.

- Upstream source and build instructions: <https://github.com/libass/JavascriptSubtitlesOctopus/tree/f5ead60c287fd6b84d4561a3b4fcc65dcd0d1f54>
- Exact npm package and integrity: `GlassesUI/package-lock.json` (`libass-wasm` 4.1.0)
- Bundled notices and full dependency license texts: `GlassesUI/public/licenses/libass-wasm-COPYRIGHT.txt`
- Wrapper license: `GlassesUI/public/licenses/libass-wasm-LICENSE.txt` (MIT)

The renderer includes libass, FreeType, HarfBuzz, FriBidi, Fontconfig, Expat and
Brotli under their respective licenses, including LGPL-2.1-or-later components.
To replace/relink the renderer, rebuild the upstream worker/WASM from the pinned
source and replace the matching files in `GlassesUI/node_modules/libass-wasm/dist/js/`,
then run `npm --prefix GlassesUI run build` and the Android assembly tasks.
The application imposes no restriction on reverse engineering for debugging
modifications to these LGPL components.

## Source Han Sans (思源黑体)

`GlassesUI/src/assets/fonts/SourceHanSansSC-Regular.otf` is Adobe's Source Han
Sans SC Regular 2.005, bundled unmodified as the fallback for missing ASS fonts.
It covers Simplified Chinese, Japanese and other CJK glyphs; media-provided
fonts take priority when available.

- Source: <https://github.com/adobe-fonts/source-han-sans/tree/release/OTF/SimplifiedChinese>
- License: SIL Open Font License 1.1, bundled in `GlassesUI/public/licenses/OFL-SourceHanSans.txt`
- SHA-256: `f1d8611151880c6c336aabeac4640ef434fa13cbfbf1ffe82d0a71b2a5637256`
