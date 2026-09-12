<p align="center">
  <img src="artwork/app-icon/tachi-icon-rounded.png" width="128" height="128" alt="tachi app icon">
</p>

<h1 align="center">tachi</h1>

<p align="center"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

> A third-party Jellyfin client for RayNeo Air glasses: the phone handles connection and remote control, the glasses handle browsing and playback, and one app provides both a 2D mirror and an SBS virtual screen.

tachi is named after Tachikoma from *Ghost in the Shell*.

This project is not an official Jellyfin or RayNeo product and is not affiliated with or endorsed by either company.

[Demo](#demo) · [Quick start](#quick-start) · [Features](#features) · [Current limitations](#current-limitations) · [Documentation](#documentation)

## Demo

See tachi in action in 90 seconds: the phone is the remote, while the glasses handle browsing and playback.

https://github.com/user-attachments/assets/5dd75ead-3682-4bb2-9181-6368b4049c73

<p align="center">
  <img src="docs/images/dual-screen-showcase.png" width="96%" alt="tachi glasses and phone companion interfaces shown side by side">
</p>

<p align="center"><sub>A tachi glasses and phone companion demo</sub></p>

## Quick start

You need an accessible Jellyfin server, RayNeo Air glasses, and a compatible Android phone. Building from source also requires JDK 17+, Node.js/npm, Python 3, Android SDK platform 35, and build tools 34.0.0.

1. Download the signed ARM64 APK from [GitHub Releases](https://github.com/buggzd/tachi/releases). To build a debug APK yourself:

   ```bash
   git clone https://github.com/buggzd/tachi.git
   cd tachi
   ./scripts/build-android.sh debug
   ```

2. Install the APK on the companion phone:

   ```bash
   adb install -r /path/to/downloaded.apk
   ```

   For a local build, use `AndroidApp/app/build/outputs/apk/debug/app-debug.apk`. Without ADB, you can send the APK to the phone and install it with a file manager.

3. Connect the glasses and launch the app. Select a Jellyfin server and sign in on the phone, then open the touchpad to control the glasses interface.

The first build installs both frontend dependency sets and runs the checks. The app controls the glasses directly through Android USB, so it does not require the RayNeo SDK or an XR space application. See the [User Guide](docs/USER_GUIDE.md) and [Development Guide](docs/DEVELOPMENT.md) for environment setup, sideloading, and troubleshooting.

## Features

- **Server and account management**: save multiple servers and multiple accounts on one server, reuse sign-in sessions when switching, and keep the current connection when an addition fails or is cancelled.
- **Phone connection, glasses viewing**: discover servers on the local network, connect manually, use Quick Connect or password sign-in, manage settings, and control the glasses from the phone; the glasses stay focused on browsing and playback.
- **Common Jellyfin browsing flows**: home content shelves, libraries, search, filters, folders, and details for movies, series, seasons, and episodes.
- **Synchronized watch state**: continue watching, next-up recommendations, favorites, watched state, and playback progress reporting.
- **Direct play with compatibility fallback**: prefer native Media3 hardware-decoded playback, fall back to Jellyfin H.264/AAC HLS when needed, and support audio tracks, text subtitles, and server-burned subtitles.
- **Two glasses display modes**: switch between Mirror 2D and an SBS virtual screen; the virtual screen has four depth levels and independent size control while keeping one video, audio stream, and playback report.
- **Diagnostics without ADB**: the phone shows connection stages and safe diagnostics, and can share a redacted troubleshooting report.
- **Chinese and English UI**: follow the system language by default, or choose Simplified Chinese / English on the phone connection page or in either settings screen; the choice is saved and synchronized.
- **Viewing preferences**: switch between liquid-glass and simpleUI, choose from four subtitle sizes, and keep the preference synchronized between phone and glasses. The player uses the selected text subtitle size.

<p align="center"><img src="docs/images/glasses-episodes.png" width="96%" alt="episode browsing on the tachi glasses interface"></p>

## How it works

| Phone companion | Glasses |
| --- | --- |
| Discover servers, sign in, manage settings and diagnostics | Browse libraries, view details, and play video |
| Move focus, confirm, and go back with the touchpad | Show the single spatial focus target and receive remote commands |
| Choose the 2D/3D display mode | Output Mirror 2D or an SBS stereo image |

The native Android layer manages runtime sessions, display modes, and messages between both surfaces. See the [Android architecture](docs/ANDROID_ARCHITECTURE.md) for the design details.

## Current limitations

tachi is a working MVP intended for sideloading on RayNeo Air companion devices. Keep these limitations in mind:

- GitHub Releases currently provide ARM64 Android packages only, and Android System WebView is required at runtime.
- `targetSdk 29` preserves the existing sideload compatibility baseline and does not meet current Google Play publishing requirements.
- Air 3s uses independent USB control. On HyperOS, you may need to enable system “Screen mirroring” manually after connecting the glasses and again after changing modes; see the [User Guide](docs/USER_GUIDE.md#眼镜显示模式).
- Offline downloads and playlist editing are not implemented yet.
- Incompatible media depends on server-side Jellyfin transcoding; the native player does not bundle a general-purpose software video decoder.
- UDP discovery is based on IPv4. IPv6-only servers must be entered manually using a hostname or a properly formatted IPv6 address.

See the [User Guide](docs/USER_GUIDE.md) for full limitations, IPv6 syntax, and troubleshooting. Future work is tracked in the [feature roadmap](docs/JELLYFIN_FEATURE_ROADMAP.md).

## Documentation

| You want to learn about | Document |
| --- | --- |
| Installation, connection, remote control, playback, and troubleshooting | [User Guide](docs/USER_GUIDE.md) |
| Environment, builds, tests, and branch maintenance | [Development Guide](docs/DEVELOPMENT.md) |
| Sessions, WebView, display, and playback architecture | [Android architecture](docs/ANDROID_ARCHITECTURE.md) |
| Implemented scope and future work | [Feature roadmap](docs/JELLYFIN_FEATURE_ROADMAP.md) |
| Versioning, signing, and releases | [Versioning](docs/VERSIONING.md) · [Release guide](docs/RELEASE.md) |
| UI, SBS geometry, performance, and archived material | [Documentation index](docs/README.md) |
| Chinese and English UI and translation maintenance | [i18n guide](docs/I18N.md) |

The documentation index separates current maintenance guides, historical research, and real-device measurements. To-dos in early designs are not current feature gaps.

## Contributing

Issues and pull requests are welcome. Read the [Development Guide](docs/DEVELOPMENT.md) before making changes. Changes involving sessions, bridges, playback, diagnostics, remote control, or display modes also require the [Android architecture](docs/ANDROID_ARCHITECTURE.md).

At minimum, run this before opening a pull request:

```bash
./scripts/build-android.sh debug
```

Use focused Conventional Commits. Do not commit credentials, LAN addresses, SDK binaries, APKs, signing files, or machine-specific paths.

## License and third-party notices

This project is licensed under the [MIT License](LICENSE), Copyright © 2026 buggzd.

The Jellyfin name and trademarks belong to their respective owners. RayNeo development documentation and hardware marks belong to their respective owners. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency and license information.

[Jellyfin documentation](https://jellyfin.org/docs/) · [Jellyfin OpenAPI](https://api.jellyfin.org/) · [RayNeo Air developer documentation](https://rayneo.gitbook.io/rayneo-devdoc/)
