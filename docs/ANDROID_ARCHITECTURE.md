# Native Android architecture

tachi is a native Android application with two local React/Vite
frontends. Android owns lifecycle, session persistence, RayNeo display control,
the external `Presentation`, and the bounded JavaScript bridges.

The product name is **tachi（塔奇）**. The Android application ID and Java
namespace remain `com.jellyfinforrayneo.client` for in-place upgrades. Existing
storage keys, device IDs and WebView bridge identifiers (including
`LucentNative` and `LumaNative`) retain their original spelling for compatibility;
these are internal identifiers, not product branding.

## Native playback

Android uses the shared `native-video` Media3/MediaCodec/GLES engine for 2D and SBS.
The glasses WebView retains catalog, controls, libass/text subtitles and the single Jellyfin
reporting lifecycle. It creates no HTML video on Android; the browser development preview
retains HTML/HLS. See [native playback, measured scope and remaining verification](NATIVE_VIDEO.md).

The bounded `playbackDiagnostic` bridge accepts only current-session preparation/fallback event enums
and safe numeric diagnostics. Playback samples, event history and failure history have independent
limits (120/64/32) and share the application diagnostic clock. A separate bounded
60-entry minute-snapshot history preserves long-session trends (cumulative counters and
recent rolling metrics, not full-minute averages). Daily SBS experimental builds also log
these sanitized samples for device measurements; ordinary builds do not.
Decoder release metadata is matched exactly to SurfaceTexture timestamps to carry media PTS
through capture, inference and depth application. Signed video-minus-depth source PTS at GL
draw is distinct from wall-clock depth age and physical presentation latency; unmatched
frames remain explicitly unknown. Decoder drops, GL sequence gaps and compositor drops
must not be reported interchangeably. No media identity or URL is exported.
Native video route validation accepts Jellyfin Videos API casing while preserving the proxy base path
and origin boundary. Rejected current-source opens return a bounded error; embedded subtitle parsing
is disabled in Media3 because libass/WebVTT owns text rendering.

The optional `liquid` daily build stores bounded full-size RGB capture leases, commits RGB/depth
pairs and computes the background warp on GLES 3.1. It repeats matched pairs when inference
is slower than decoding, and invalidates pairs on source/seek generations. Pair PTS agreement
is separate from decoded-video lag; audio timing is not delayed by this experiment. ASS/WebVTT use the last accepted pair
position when available; reporting/seek retain the player media clock.
See [implementation and pending device checks](performance/2026-09-14-native-liquid/README.md).

Stable, hardware-confirmed modes survive phone Activity pause/resume without an automatic
USB 2D/3D round trip. Pausing an unconfirmed transition still requests safe 2D; actual
disconnect/destroy handling is unchanged. An OS-disabled display still needs system consent.

## Runtime topology

```text
MainActivity
├── CompanionWebViewController
│   └── CompanionUI on the phone display
├── SessionRepository
├── JellyfinAuthenticationService
├── JellyfinDiscoveryService
├── RemoteCommandRouter
├── RayNeoDisplayController
│   └── RayNeoUsbDisplayClient (Android USB Host)
└── GlassesPresentationController
    └── Presentation on the selected external display
        └── GlassesWebViewController
            ├── NativePlaybackController → native-video Surface / GLES
            ├── black transition view
            └── StereoMirrorLayout
                └── one GlassesUI WebView
```

The phone owns discovery, credentials, Quick Connect, account/display settings, and the
touchpad with a selectable textured or OLED-black background. The glasses own catalog browsing, details, native playback controls, subtitles, appearance settings, and Jellyfin playback reports. A visible glasses frame
already implies a phone connection, so `GlassesUI` has no waiting-for-phone
screen.

## Session boundary

`SessionRepository` is the only native session source. Its private
`SharedPreferences` file remains named `jellyfin_companion`, allowing an
upgrade from the former Android activity to reuse its already validated
session. The legacy `session_json` entry migrates once into the bounded
`accounts_v1` registry, then is removed. The registry stores up to 12 validated
server/user sessions and exactly one active account ID in one JSON value.
Each entry has an opaque 32-character local ID; the server URL and user ID
identify an existing login when its token is renewed. A non-persistent login
is switchable only in process memory and never enters the persisted registry.
If the active login is transient, a cold launch has no active account but still
allows choosing the other saved accounts.

Every restored or newly authenticated session is rebuilt from exactly these
eight string fields:

- `serverUrl`
- `serverName`
- `serverVersion`
- `serverId`
- `accessToken`
- `userId`
- `userName`
- `deviceId`

Required values, field lengths, JSON size, URL scheme, and URL authority are
validated before the session is accepted. Extra fields are discarded. The
password is never persisted or included in a state payload; the authentication
request removes it from the JSON object and wipes its byte and character
buffers in `finally` blocks. Logs contain only generic failure categories.

Server URLs support IPv4, host names resolved through A/AAAA records, bracketed
IPv6 literals with an optional port, and Jellyfin subpaths. A bare IPv6 literal
without a port is bracketed during normalization. A literal with a port must use
the standard `http://[address]:port` form. Scoped link-local literals containing
a zone identifier are rejected because Java and Chromium WebView do not share a
reliable URL representation for them. Jellyfin UDP discovery remains IPv4
broadcast based, so IPv6-only endpoints are entered manually through an AAAA
host name or a global/ULA literal.

Server selection and an in-progress login leave the active account unchanged.
Only successful authentication or explicit activation of an existing account
replaces it and publishes a new bootstrap directly to the glasses WebView.
Switching clears previous playback, remote commands and search state; glasses
navigation and the player reset for the new identity. Logout, removal of the
active account and a Jellyfin `401`/`403` remove that account, pending remote
commands, playback snapshot, and in-memory glasses bootstrap. Other saved
accounts remain available. Unauthorized events carry a bounded catalog
generation; a late response from a previous account cannot clear the new one. There is no polling loop or second
session replica. Native bootstrap payloads are compared with the last payload
before injection, and `GlassesUI` compares their normalized value again before
notifying React. A bounded `catalogGeneration` changes only after login or an
explicit catalog retry, so display-state publications cannot cancel and restart
the catalog requests.

## WebView bridges

Both WebViews load only their own `file:///android_asset/...` root. Main-frame
navigation outside that root, traversal segments, backslashes, NULs, and
percent-encoded paths are rejected. JavaScript interface inputs are normalized,
length-limited, and whitelisted before use.

`CompanionUI` calls `window.JellyfinNative`:

| Method | Purpose |
| --- | --- |
| `getState`, `ready` | Initial state and receiver readiness |
| `scan`, `selectServer` | UDP discovery and login target selection, retaining the active account |
| `activateSession`, `removeSession` | Activate/remove an existing opaque account ID; arbitrary or oversized IDs are rejected |
| `login`, `startQuickConnect`, `cancelQuickConnect` | Authentication |
| `clearSession` | Logout and forget the active account |
| `retryGlasses` | Republish the session bootstrap after a catalog failure |
| `shareDiagnostics` | Open Android's share sheet with a redacted diagnostic report |
| `selectDisplayMode` | Save and request 2D/3D mode |
| `selectUiTheme` | Persist exactly `liquid-glass` or `simpleUI` and publish it to both surfaces |
| `selectTouchpadBackground` | Persist exactly `texture` or `black` for the phone remote only |
| `chooseCompanionBackground`, `clearCompanionBackground` | Pick/reset one private phone wallpaper from settings; picking is limited to the Liquid theme |
| `setCompanionBackgroundLayout` | Save bounded crop/transparency metadata for the current image revision from settings; publish phone state only |
| `setCompanionGlassTransparency` | Save an integer 0–100 glass transparency from settings, independently of wallpaper; publish phone state only |
| `openProjectPage` | Open only the fixed public project, issue list or guide page in the system browser |
| `selectLanguage` | Persist exactly `system`, `zh-CN` or `en` and publish language/system locale to both surfaces without reloading either WebView |
| `selectSubtitleSize` | Persist exactly `small`, `normal`, `large`, or `extra-large` and publish it to both surfaces |
| `setStereoScreen` | Save a bounded flat-screen disparity/size preference without switching hardware mode |
| `setStereoTestPattern` | Enable/disable the temporary L/R reference overlay while stereo is applied |
| `remoteCommand`, `searchText`, `previewHaptic` | Bounded touchpad input and the active Series-search query |
| `copyQuickConnectCode`, `openQuickConnectAuthorization` | Phone helpers |
| `screenChanged` | Phone surface and back-navigation state |

Android pushes phone state through `window.LumaNative.receiveState`. This state
includes connection, display, discovery, playback, and bounded search UI data,
but never the access token or password. Its account list contains only the local
ID, server metadata, username, persistence flag and active flag. `serverUrl` and
`username` describe the active account; separate `loginServerUrl` and
`loginServerName` describe the pending login target. Browsing the `accounts`,
`connect` and `auth` surfaces never clears the active account, and state updates
cannot redirect a pending login back to the current connection. Phone
localStorage does not store native account/session metadata.
While the glasses search page is open,
`searchInputActive=true` moves the phone to its touchpad, focuses its search
field, and requests the system QWERTY keyboard; `searchQuery` mirrors at most 48
lowercase ASCII letters, digits, and spaces. `glassesPresentationReady` means
only that the local glasses page is running; `glassesRuntimeState=ready` and
`mediaReady=true` mean that page actually loaded the Jellyfin catalog. The phone
keeps a glasses-side failure visible so field testing does not require ADB.

`GlassesUI` calls `window.RayNeoGlasses`:

| Method | Purpose |
| --- | --- |
| `getBootstrapState`, `ready` | Receive the whitelisted session and display state |
| `getHardwareVideoCodecs` | Enumerate hardware video decoder families |
| `postMessage` | Send validated runtime/playback/session events to Android |
| `realtimeSbsAvailable` | Whether this build/API includes the experimental QNN depth route |
| `nativePlaybackAvailable`, `getNativeAudioCodecs` | Native player and system audio capabilities |
| `nativePlaybackCommand` | Bounded open/play/pause/seek/stop/depth/subtitle-status requests, tied to session generation and playback token |

Accepted glasses messages are `manage_login`, `logout`, `unauthorized`,
`runtime_state`, `playback_state`, `search_state`, `set_ui_theme`, and
`set_subtitle_size`, and `set_language`. Appearance messages accept only an exact whitelisted string
in `value`, with no coercion, trimming, or arbitrary style payload. The whole message and
every individual field have fixed limits. `search_state` carries only
`active`/`inactive` plus the bounded ASCII query; leaving search, logout, a lost
glasses WebView, or an unauthorized restore clears the phone input and hides
the IME. Remote commands are limited to direction, enter, back, a bounded
volume percentage, bounded `seek` deltas, bounded `search-text`, search submit, and keyboard visibility
signals; the pending queue holds at most 32 items.

`runtime_state.errorCode` accepts only `none`, `network`, `http`, `response`, or
`unknown`. Android maps those categories to fixed diagnostic source messages, localized by the
phone UI, and never
forwards a Jellyfin response body, URL, token, or arbitrary exception text to
the phone. A `loading` or `ready` transition clears an older runtime error.

Directional keyboard events originate at `document.activeElement`, falling
back to `document.body`, and bubble from an element target. `GlassesUI` owns the
single `data-spatial-focus="true"` marker. While video is active, the player
scope prevents underlying pages from receiving input.

An external Android WebView can update `activeElement` without emitting `focusin`
while the phone owns window focus. `focusSpatialElement` uses
`focusWithNotification` to observe the synchronous native focus event and supply
one bubbling `focusin` only for a changed logical target when that event is
missing. React preview and focus-region callbacks therefore follow remote
selection in both Mirror 2D and SBS. Normal browser focus is not notified twice;
reselecting the same logical target does not repeat the fallback notification.

Seeking uses the existing `remoteCommand` bridge. Legacy `seek:N` deltas remain
bounded to nonzero integers from -60 to 60. Preview transactions use
`scrub:start:ID`, `scrub:preview:ID:SECONDS`, `scrub:commit:ID:SECONDS` and
`scrub:cancel:ID`: ID is exactly eight lowercase hex characters and SECONDS is
a canonical whole number from 0 to 999999, additionally clamped to duration.
Commands are bounded to 32 characters. Native and the player both require
`playback_state.seekEnabled`: visible controls, seekable media, progress focus,
no track panel, and no preparing/error/stopped state. Neither deltas nor preview
transactions enter the reconnect queue. Commit requires a matching live start;
duplicate, expired and cancelled commits have no effect.

The remote enters immersive fullscreen, hides status/navigation bars, fills cutout
regions with the black window surface, and restores bars on exit. Window-focus
return reapplies the current surface policy; system edge swipes may reveal
transient bars. Progress focus adds no phone-side gesture instruction overlay.

The phone replaces the dial with horizontal distance-based preview: a stroke
crossing 72 CSS px horizontally uses 0.5 seconds/px, with no velocity gain.
Short swipes retain ten-second steps; vertical navigation and tap actions remain.
A consumed drag cannot become a tap or direction on release. The phone's full
range slider uses the same preview transaction and focus permission. Preview
updates are throttled to 80 ms, with a 500 ms keepalive while the finger rests.
The glasses show target time and offset and hold controls visible, without
changing the media clock; release commits exactly one seek and preserves pause.
Controls publish the current phone timeline once per second while visible;
Jellyfin's reporting cadence is unchanged.

Focus loss, plan/item changes, pointer cancellation, multiple pointers, hidden
phone document and blur discard previews. The player expires a transaction after
2 seconds without an update (checked every 500 ms). Preparing or losing permission
also discards it. The player retains the single video and reporting lifecycle.
The play/pause button has a neutral resting fill and highlights only on focus;
the focused progress bar is thicker with an enlarged thumb and contextual hint.
Browser gesture checks do not replace real touch sampling or direct/HLS latency
and pause-state checks in both display modes.

Phone hardware volume keys are consumed by `MainActivity` and mapped directly
to one `AudioManager.STREAM_MUSIC` raise/lower/toggle adjustment per key-down.
The resulting stream value is published immediately after that exact adjustment;
the matching key-up is consumed without another change. The application does
not queue a directionless volume read behind Android's default key dispatch, so
a rapid down-to-up or up-to-down reversal cannot publish the preceding direction.

### Android controllers

`GamepadInputController` receives key and generic-motion events from both the phone
Activity and glasses Presentation on the main looper. It recognizes gamepad,
joystick and D-pad source masks/device capabilities, preserving ordinary keyboard
and volume handling. The pure `GamepadNavigation` state machine maps D-pad keys/HAT
axes and the left stick to directions, A/center/Enter to confirm, and B/controller
Back to glasses back. Other controls keep their system handling; no vendor SDK,
Bluetooth scan permission, raw HID protocol, second WebView or player is added.

Navigation requires a resumed Activity, focus in either application window, the
phone touchpad surface, a valid session, a ready glasses catalog/WebView, an available
external display and no hardware-mode transition. Loss of eligibility cancels holds.
Owned releases remain consumed afterward. Mapped controller keys in the glasses
window, or the phone remote outside text input, cannot fall through to default
WebView navigation while delivery is unavailable.

At most eight devices share one active controller and one repeat task. Directions
start immediately and repeat after 350 ms at 120 ms intervals; OS repeats add no
actions. Confirm/back execute once per press. D-pad key/HAT duplicates share direction
state; key directions take priority over HAT, then left stick. Stick activation/release
thresholds are 0.55/0.35 with device flat ranges respected and dominant-axis hysteresis;
these are initial parameters, not device measurements. At most 32 historical motion
samples are folded before the current sample, with at most one move per motion batch.
Unused neutral axis events are not navigation. InputManager callbacks cancel removed/
changed devices; switching controllers blocks the old hold until release/neutral.

`RemoteCommandRouter.submitImmediate` validates the existing whitelist and never
queues input, including when its sink rejects delivery. Failed delivery cancels
repeats. Phone remote commands, confirm/back, session cleanup, mode transitions,
renderer loss and foreground/focus changes interrupt old holds. Controller connection
changes do not themselves change playback or session identity.

Phone state adds a transient `gamepadNavigation` boolean for the last navigation
source, not a device connection claim. A controller-opened search suppresses phone
autofocus and the native IME request. Explicit phone search focus temporarily owns
text input; blur restores controller eligibility, using the existing bounded
search-keyboard messages. No controller identity, descriptor, Bluetooth address or
input text is persisted or exported. Both languages include controller guidance and
a tutorial skip hint. Desktop verification covers the implementation; physical
controller, IME and dual-display acceptance remain pending (no ADB/device checks).

### Remote tutorial

The remote tutorial is a separate glasses React surface, shown once after the
catalog becomes ready and reachable again through the side navigation. It
consumes the existing bubbling keyboard event only, not the paired
`rayneo-remote-command` notification, and owns one spatial focus marker. Catalog
pages and the player are unmounted during practice; search input is inactive.
Wrong gestures cannot pass a lesson, and the success beat consumes repeated
input before advancing. An exit dialog makes the practice surface inert.
Session loss unmounts the tutorial and drops in-progress practice. Only a
versioned `completed`/`skipped` flag is saved in glasses localStorage; no session,
media, or account data is stored there. The tutorial creates no video, native
bridge method, playback report, WebView, or display-mode transition.

The glasses search surface uses one Apple TV-style A-Z/0-9 character strip as
a remote-only fallback and shows Series posters without episode rows. Pressing
down enters the poster grid; up from its first row or left from its first column
returns to the strip. Phone QWERTY input updates results on every edit, and the
phone keyboard's search action focuses the first matching Series. Full pinyin,
pinyin initials, English titles, and optional season/episode hints are resolved
locally from the bounded Series index.

Collection browsing keeps Jellyfin's container hierarchy: a `boxsets` library
lists `BoxSet` containers, and each collection loads only its direct children.
Requests resolve the view using `ParentId` without `IncludeItemTypes`, matching
Jellyfin Web: filtering a virtual collection view by `BoxSet` can return root
libraries instead of its collections.
Films and series still open their respective details. The glasses frontend
retains the in-memory breadcrumb path while visiting details; remote Back and
the breadcrumb back button both leave one container level at a time. A fresh
library entry or account change clears the saved path.

## UI appearance preference

`SessionRepository` stores `ui_theme` independently of accounts and display mode.
Missing or unknown saved values use `liquid-glass`; `selectUiTheme` rejects every
value except the two exact theme names before scheduling work on the UI thread.
Both the phone state and glasses bootstrap include `uiTheme`. A theme edit updates
system bars and the phone WebView background, then publishes the existing state
channels. It does not increment `catalogGeneration`, request hardware mode changes,
recreate a WebView, or remount the video. Logout preserves this device preference.

Both React entry points restore the theme before their first render. The phone
uses native acknowledgements to update its radio selection; it stores no second
copy of the native preference in localStorage. Standalone browser previews and the
dual-UI harness may save only the appearance choice under a preview-specific key.
`SharedUI` supplies the exact enum normalization and simpleUI rendering rules;
both Gradle frontend tasks include that directory in their build inputs.
See [UI themes](UI_GUIDE.md) for the visual design and verification boundary.

The glasses side navigation includes Settings, with the same theme choices and
a live subtitle-size preview. Both surfaces can edit the device-wide
`subtitle_size` preference in `SessionRepository`; missing/corrupt values use
`normal`, and invalid edits leave the saved value unchanged. The four sizes are
small (80%), normal (100%), large (125%), and extra-large (150%) of the existing
responsive text size. The phone's reset-preferences action restores normal.
Native acknowledgement updates both selections without changing the catalog
generation, client, video element, playback plan, or reporting lifecycle.

Size choices are available only on the Settings pages; the player uses the saved
size without adding font controls to its playback or subtitle menus.
Sizing applies to ordinary WebVTT text subtitles; ASS/SSA retain authored
font sizes and positioning. Burned-in/bitmap subtitles already in the video
cannot be resized by this preference. Logout preserves both appearance
preferences, and standalone previews persist only their dedicated preference keys.

Glasses UI sounds are a separate, glasses-only localStorage preference
(`rayneo.glasses.ui-sounds.v1`, exact `off` disables, otherwise enabled).
`UiSoundPlayer` preloads a bounded pool of local MORI PCM clips in the existing
glasses document, with at most one UI clip playing at a time. Repeated cues are
throttled; a held direction at the same focus boundary sounds once until focus
moves or direction changes. Navigation/enter/back use only the keyboard/click
path, while volume uses the existing remote notification. Initial/restored
focus is silent.
Mute, document hiding and page teardown stop pending/active UI audio; failed
playback has no retry queue. Re-enabling plays one confirmation; disabling is
immediately silent. Storage failure applies the choice in memory and is shown
in settings. The phone has no sound setting, player, or new bridge message.
This preference survives logout and renderer recreation, independently of native
appearance preferences and the phone's reset action. UI clips neither control
nor duplicate the single video soundtrack or Jellyfin reporting stream; stereo
draws the same document twice and never creates a second sound player.

The player page is a silent UI-sound scope: focus, select, back, seeking,
panels, toggles, boundaries and errors do not play UI clips there. Only the
existing remote volume notification may play the `volume` cue during playback.
This keeps UI feedback separate from the video soundtrack.

Phone wallpaper is a separate private JPEG owned by `CompanionBackground`, not
a session or glasses preference. A system single-image picker grants temporary
access to a `content` URI without storage permissions. One bounded worker reads
at most 20 MiB, validates JPEG/PNG/WebP dimensions (64 MP and 16000 per edge),
downsamples before decoding, corrects EXIF orientation with AndroidX, and saves
an opaque JPEG with a maximum 1600-pixel edge using `AtomicFile`. Original metadata
is discarded. Cancelled/failed imports retain the previous image; lifecycle
teardown cancels unfinished work. The image bridge publishes a busy flag and a
fixed virtual HTTPS asset URL with an opaque revision. The companion WebView
intercepts that exact route and streams the private file with `no-store`; there
is no wallpaper network request, arbitrary file path or image-byte bridge call.
The URI, image and revision do not enter glasses bootstrap or diagnostics.
Browser previews own a separate compressed image in IndexedDB. SimpleUI and
the touchpad do not render the wallpaper; logout and theme changes preserve it.

`SessionRepository` owns `companion_background_layout`: six bounded fields for
transparency (0–100), aspect preset, zoom (100–300), and normalized X/Y crop
travel (0–1000), plus text color (`auto`, `light`, `dark`). Old five-field records
retain their crop and default to automatic text. `CompanionBackgroundLayout` rejects
oversized JSON, extra/missing fields, unknown ratios/colors, nonnumeric and fractional
values, and out-of-range inputs.
The settings bridge additionally requires the current 32-character image revision
and an idle image importer. Saving publishes only `companionBackgroundLayout` in
phone state, never a glasses bootstrap. The editor keeps a draft until Apply and
waits for that acknowledgement; cancel/Back leaves the saved layout intact.
One source-coordinate crop feeds both SVG preview and wallpaper. The imported
JPEG stays intact; replacing it resets crop geometry and preserves transparency and text color,
while clearing resets all layout fields. Browser previews store image and layout
in one IndexedDB transaction and migrate old Blob-only records on the next save.

The exact private JPEG route grants CORS only to the trusted file document's `null`
origin, allowing a local canvas to build one small contrast raster. HTTP(S) origins
receive no CORS grant; the route remains local to the companion WebView. The raster
never enters persistence, diagnostics, the bridge or the glasses. Image loading can
fall back to display-only/manual colors if sampling is unavailable. Automatic color
uses the final crop/opacity and per-text screen bounds, including glass fill; a
coalesced event-driven update follows scrolling/resizing without an idle loop.

The phone About section reads `BuildConfig.VERSION_NAME` and `VERSION_CODE` from
state; browser builds read the root `version.properties`. External settings links
accept only exact `project`, `issues` and `guide` identifiers, then launch their
fixed public HTTPS pages. They never navigate either application WebView away
from its asset root. Collapsing the display settings ends the eye test overlay.

`companion_glass_transparency` is a separate `SessionRepository` preference (0–100,
default 88), with no image revision requirement. Its bridge accepts only a bounded
canonical integer string from settings and publishes `companionGlassTransparency`
to the phone. The frontend previews slider edits immediately and ignores older
acknowledgements until the latest value arrives. Device/settings/account cards,
nested choices and navigation share the white fill; text samples compose the actual
stacked fill. The central touch key is opaque and above the navigation rim. Theme
changes, logout and wallpaper removal preserve the value; reset restores 88.
Neither the glasses bootstrap nor the touchpad uses this preference.

The phone-only `touchpadBackground` state comes from `SessionRepository`'s
`touchpad_background` preference. Until a valid choice is saved, Liquid uses
texture and simpleUI uses black. Explicit choices survive theme switches,
account changes and process recreation; reset preferences selects Liquid and
texture. No glasses bootstrap or hardware transition is published for a remote
background edit. Browser preview/harness storage is separate from Android.

Black mode renders opaque `#000` from the document root through the touchpad and
its search/playback panels. Ambient art, grain, finger glow and decorative rings
are unmounted or suppressed; filters, shadows and entry fades cannot raise the
black background. Foreground text, controls and brief gesture glyphs remain
visible. Native window, WebView and system bars use `Color.BLACK` on the remote;
navigation dividers are black and Android 10+ contrast scrims are disabled there.
The WebView also disables overscroll effects. The IME and external system overlays
remain controlled by Android. Zero-valued screenshot pixels verify software
output, not physical OLED emission or device-specific display processing.

## RayNeo display state

`RayNeoDisplayController` controls the verified Air 3s HID interface directly
through Android USB Host APIs. The APK has no RayNeo SDK, XR Space binding,
package query or launcher integration. The historical SDK/official control
implementation was used only to establish the two mode reports; no vendor
binary is bundled. Protocol provenance is recorded in
[SBS geometry analysis](SBS_GEOMETRY.md#usb-模式控制).

`RayNeoUsbDisplayClient` accepts only USB VID/PID `1bbb:af50`, interface 0,
HID class 3/subclass 0/protocol 0, and the verified interrupt endpoints
`01`/`81` with 64-byte packets. Only 64-byte reports `66 06 00…` (SBS) and
`66 07 00…` (2D) are supported. A single worker with a one-item queue discards
obsolete requests; `UsbRequest` has a 750 ms wait and always releases the
claimed interface and connection. It never writes firmware, resets USB, or
sends arbitrary WebView-provided bytes.

Android grants USB access to this application through the standard system
permission dialog. The private receiver checks the actual `UsbManager` grant,
not broadcast extras. Waiting for consent reveals content and does not run a
hardware timeout. Denial leaves the mode unconfirmed, without reopening the
prompt on resume. An explicit selection can request consent again. Permission
dialog lifecycle is kept separate from leaving the application.

The manifest matches only Air 3s VID/PID for `USB_DEVICE_ATTACHED`, allowing
Android's user-selected default handler to grant access and launch tachi on
attachment. Runtime identity/interface validation still applies; intent extras
are never treated as proof of consent. Default handling is system-dependent and
may launch the app automatically. Installation itself grants no USB access.

`StartupStereoPreparation` permits one early SBS preparation per Activity when
the saved mode is stereo and a named, OS-disabled glasses display reports an
actual 1920×1080 physical mode, before a Presentation is connected. Unknown
geometry, an already-SBS display, and Mirror 2D never qualify. It uses the same
USB permission and bounded command path. Permission waiting and subsequent
waiting for system mirroring do not hide content or mark stereo applied. A
successful early write is reused when the external window becomes available;
the normal physical/View validation and transition deadline still apply. Denial
or write failure is not retried by repeated display events. Explicit mode
selection cancels pending work and returns to the normal mode path. This is a
startup optimization, not a background service or a bypass of system consent.

The state machine keeps these values separate:

- `requestedMode`: saved phone preference
- `activeMode`: layout currently safe to show
- `displayModeApplied`: exact hardware mode was confirmed
- `displayModeTransitioning`: a bounded hardware transition is in flight

```text
request mode
  -> observe initial Presentation geometry
     -> physical/View output already matches: apply without a USB command
     -> USB permission needed: reveal content and wait for system consent
     -> permission available: send one mode report, then observe physical/View output
        -> requested mode confirmed: apply and reveal WebView
        -> unavailable/timeout: end transition, request safe 2D once, stop retrying
```

Only an active transition hides the WebView. The hardware/geometry deadline is
8 seconds; USB permission waiting is outside it. A completed USB write alone
cannot mark stereo applied. A fresh attempt occurs after an explicit selection,
reconnect or lifecycle resume. Returning to an already-correct physical mode
uses the measured output and avoids another EDID reconnect. Outside the startup
preparation exception, the initial window must be measured before sending a command.

Stereo requires both physical `Display.Mode` and the measured Presentation
root to have a Full-SBS 32:9 aspect, even width, and at most two pixels of width
rounding. A physical 3840×1080 mode may have a uniformly downscaled 1920×540 View;
1920×1080 half-SBS is unsupported. Mirror confirmation requires physical
1920×1080 and a nonempty root. `DisplayOutputGeometry` tracks physical/View
pixels, refresh rate and readiness, including same-ID changes. Losing valid
stereo geometry falls back once; late events do not restart a failed transition.
These conditions do not replace optical calibration or eye-order testing.

`GlassesPresentationController` prefers a valid RayNeo/TCL presentation display.
A named glasses display temporarily reporting OFF remains eligible; the phone's
sleeping rear screen does not. While connected, the phone and glasses windows
keep the screen awake.

A physical switch can remove and recreate Android's logical display because its
EDID changes. During the existing 8-second transition, the controller retains
the one WebView and reparents it to the replacement Presentation without
reloading the document/video. Old-window layout callbacks are ignored. If the
transition ends without a usable display, the retained WebView is released.

The retained WebView uses the phone Activity's stable rendering context. The
Presentation still owns its external window, container and measured pixels.
Creating the renderer with a disappearing external-display context can leave
Chromium's cached display density inconsistent after an EDID reconnect. Merely
replacing a `MutableContextWrapper` base does not repair that cached state.
`GlassesUI` declares a 1440 CSS-pixel viewport without a forced initial scale;
WebView overview fitting maps the complete page to the measured per-eye width.
For a 1920×1080 source View this gives 1440×810 CSS pixels. Renderer
`screen.*` and device pixel ratio may describe the phone; hardware confirmation
continues to use `Display.Mode` and the external root, never those JS values.

On the tested Xiaomi HyperOS device, connecting glasses or changing modes can
require the user to enable the system's **screen mirroring** control before
external content is allowed. `glassesDisplayDisabled` identifies that connected
but disabled output through a read-only display category. The phone asks the
user to enable screen mirroring; it does not open XR Space or treat another
app's startup as a remedy. Except for the single startup preparation described
above, no USB mode reports are sent while system output is disabled.
App fallback removes its black layer but cannot enable
an OS-disabled screen. The user's system permission action and the eye-mode
command are separate requirements.

## Field diagnostics without ADB

The phone settings screen can open Android's `ACTION_SEND` chooser with a
UTF-8 `.txt` attachment suitable for QQ or another sharing app. A bounded worker
saves at most three reports (512 KiB each) in a dedicated private cache directory.
A non-exported FileProvider grants read access to the selected report only. Live samples
are retained in memory and contains app/Android/WebView versions, device model, boolean
session state, derived server shape, derived active-network capabilities,
glasses/WebView/runtime/display state, numeric output dimensions/refresh rate,
stereo settings and test-pattern state, and at most 160 fixed event enum values.

The server is represented only as `http`/`https`, host kind
(`hostname`/`ipv4-literal`/`ipv6-literal`), and whether it has a subpath.
Network addresses, DNS server values, server URL, account, media titles,
Quick Connect code, session payload, credentials, response bodies, and
arbitrary exception text are never exported.

Diagnostic format 5 adds process-independent crash evidence. `TachiApplication`
installs the Java fatal handler once, persists only the latest bounded summary
(four causes, sixteen symbol-only frames each, time and version code), then delegates
to Android's original handler. Messages, filenames and thread names are omitted.
A finite background startup task reads it and up to eight system exit records for
this exact process on Android 11+. Native crashes and ANRs are identified by system
reason/status; system history can be evicted and cannot identify the old app version.
On Android 12+, native tombstones are read up to 1 MiB each solely for fixed ORT/JNI
failure signatures; raw protobufs, abort messages, memory and paths are never saved
or shared. Unavailable/truncated evidence is explicit. Older Android versions retain
Java summaries only. No crash uploads, new exported components or debugging flags
are enabled; users share the existing diagnostic attachment after restarting.

Full Release must keep the complete `ai.onnxruntime` JNI surface. The local QNN
AAR has no consumer keep rules; native lookups include constructors, fields and
enums invisible to R8. `verify-ort-jni.py` rejects stripped or renamed ORT APIs and
a missing `NodeInfo(String, ValueInfo)` constructor. Debug/experimental playback,
APK hashes and an install-only smoke test cannot replace testing realtime 3D in
the minified, officially signed Release on device.

## Single-WebView stereo rendering

`StereoVirtualScreen` does not create a second WebView. `StereoMirrorLayout`
measures the one glasses WebView at per-eye width, draws its frame into the left
half, and draws the same frame again into the right half with a different
horizontal transform. This preserves one
native Media3 player, one audio stream, and one set of Jellyfin playback reports.
The native video Surface is a sibling underneath the transparent WebView. GLES draws
each eye directly with the same geometry; Canvas never attempts to clone a SurfaceView.

`StereoScreenGeometry` uses total eye-local disparity `d = uL - uR`: left
translation is `inset + d/2`, right is `inset - d/2`. Positive disparity adds
convergence. Translation occurs before a uniform Canvas scale so disparity does
not change with screen size. Each eye clips to its own viewport; centering and
`s*N + |d| + 2*m <= N` preserve the entire image with at least 1% edge margin.
GLES clears unused video space; the UI container is transparent during native playback.
Ordinary playback has no CPU image readback; optional QNN sampling reads only a small image.

`StereoScreenSettings` stores only `depthLevel` (integer 0–3) and `sizePercent`
(integer 80–95), in the native repository. The JSON bridge accepts exactly these
two numeric fields within 128 characters. Levels correspond to total disparities
0/8/16/24 at a reference width of 1920 per eye, scaled by actual View eye width.
The initial preference is level 1 and 90%; these are initial engineering values,
not measured comfort limits. Unknown optical zero distance and individual IPD
mean the UI uses relative proximity rather than an uncalibrated distance in metres.
Normal 2D content remains a flat screen and follows head motion.

Settings animate disparity and size over 180 ms (respecting disabled system
animations) using matching Canvas and GLES transforms. They do not request a new WebView
layout, bootstrap, hardware switch or player. WebView descendant invalidations
redraw both eye copies together; the settings animator invalidates changed
geometry. There is no unconditional stereo vsync loop, so static pages and
paused video can stop submitting frames. Video, subtitles, CSS motion and scroll
must still update both eyes; moving-video device checks are required when this
invalidation path changes.

The phone and Mirror 2D use WebView's normal hardware-accelerated window drawing
(`LAYER_TYPE_NONE`, not a software layer). Applied stereo alone retains one
explicit hardware View layer so both transformed eye draws reuse the same
WebView texture. No second WebView, video, decoder or audio stream is created.

Player sound bars and the phone touchpad introduction retain their visible
animation and full exit transition. `SharedUI/hiddenAnimations.mjs` waits for the
root's finite transitions to settle before CSS pauses the invisible decorative
loops. Reveal cancels pending suspension before paint and restores CSS's own
play state, including a paused video's bars. Older WebViews without animation
inspection retain the existing behavior. Blur and visible decorative motion
remain unchanged; see the [performance follow-up](performance/2026-09-07/README.md)
and [version-pinned blur audit](performance/2026-09-07/blur-audit.md).

`stereoScreen`, `stereoOutput`, `stereoTestPattern` and `glassesDisplayDisabled` are included in native phone
state. The frontend keeps an in-memory editor, ignores older acknowledgements
while the latest edit is pending, and does not persist another copy of these
preferences in localStorage. Settings survive disconnect, Activity recreation
and logout. The pattern is transient: exact bridge values `on`/`off` are accepted;
enabling also requires the phone settings surface, a ready glasses WebView and
applied stereo. White frames have zero added disparity, L/R identify eye channels,
and cyan targets share the content transform. The overlay leaves video visible.
Leaving settings, mode exit/failure, pause, disconnect, logout or renderer loss
clears it. See [SBS geometry analysis](SBS_GEOMETRY.md) for derivation,
official parameter sources and optical/device limitations.

The native bridge enumerates hardware video decoders and supported audio families.
Direct-play profiles use native Media3 demuxer support (MP4/WebM/MKV), bounded hardware
video profiles and system audio decoders. Limits are 3840×2160 and 120 Mbps;
H.264/VP8 are 8-bit, HEVC/VP9/AV1 at most 10-bit. Known HDR is sent to server SDR
transcoding because the current GLES output is RGBA8. Unsupported media and runtime
direct-play failures use Jellyfin's 24 Mbps H.264/AAC stereo HLS fallback.
Media3 owns HLS transport, demux, audio synchronization and native audio-track selection.

ASS/SSA are delivered as original ASS to the local `libass-wasm` worker,
loaded only when such a track is selected. Other text codecs use WebVTT.
The device profile advertises ASS/SSA/VTT/WebVTT as external delivery. Video
requests explicitly select subtitle index `-1` for local tracks, omit subtitles
from HLS manifests, and strip burn-in selection from stale fallback URLs. Only
bitmap tracks request server burn-in. A failed ASS renderer shows a local error;
it never silently converts to plain text or requests server burn-in.

The one transparent canvas follows the actual `object-fit: contain` image rect,
including letterboxing, below playback controls. The worker uses libass's ASS
styles, layers, positioning, transforms, karaoke, alpha and vector clipping;
no override tags or animations are stripped. It follows the native media clock with
bounded interpolation between 100 ms updates, via rAF, and stops
callbacks while paused or hidden. Seek, resize and resume resynchronize the same
media timeline. The source request starts at zero, including during resumed HLS.
Stereo copies the same WebView/canvas; there is still only one video and audio stream.

Media font attachments take priority; bundled Source Han Sans SC (思源黑体,
SIL OFL) supplies missing glyphs/fonts without an online font service. ASS uses
its authored sizes, independent of the ordinary subtitle-size preference.
The canvas backing size is bounded to 1920×1080. Subtitle text is limited to
16 MiB; optional fonts to 24 attachments, 20 MiB each and 48 MiB total with a
15-second aggregate loading budget. Unavailable optional fonts use the fallback.
Libass bitmap/glyph caches are limited to 32/8 MiB. These are resource budgets,
not a guarantee that every extreme ASS script is inexpensive.

APK resources are loaded with bounded XHR (`file://` status zero is accepted),
then exposed to the WASM worker as temporary blob URLs. The worker receives
subtitle content and font blobs, never authenticated server URLs. No new native
bridge or file-origin permission is introduced. Track changes, logout, unmount,
abort and critical worker failures terminate the worker, cancel frame callbacks,
clear pixels and revoke blob URLs. Worker log text and arbitrary window actions
are not forwarded. See the [subtitle regression fixture](DEVELOPMENT.md#ass-字幕回归).

Playback teardown captures the media clock before the video ref and HLS source
are detached. Detail reloads wait for pending stop reports, then read fresh user
data. The account-scoped Jellyfin client retains at most 64 local watch positions
to preserve short sessions below the server's resume threshold; it does not
persist them. Newer server history and explicit watched-state edits supersede
these positions. Series details choose the latest watched season unless a season
was explicitly selected; the hero resume button and first entry into the episode
rail use the latest watch date. Search episode hints remain explicit until playback
begins. The rail is positioned without scrolling the hero away or moving initial
focus, and displays one recent-watch marker per season.

The glasses player's optional video-information overlay reads the existing
playback plan and native output formats, decoder name, buffering and decoder counters. It distinguishes output parameters from the
original media and samples once per second only while enabled and the document
is visible. It adds no server polling, native bridge method, player, or report
stream. Changing sources invalidates previous samples; changing episodes keeps
the toggle within that playback visit, while leaving playback or switching
accounts clears it. Hardware enumeration describes capability; the native decoder field identifies the actual component.
The isolated browser preview continues to report WebView limitations.

## Realtime native depth conversion

The Full production route from v0.4.0 is **392×224 strictly paired RGB/depth with GPU local
background liquid warp**, strength 0.85, feather 96 px at a per-eye source width of
1920, amount 65%. See [route decision](SBS_TECHNICAL_ROUTES.md) and
[build and acceptance status](REALTIME_SBS.md). Full uses this complete configuration
with daily fixtures disabled. User approval of visual quality is separate from device acceptance.

The liquid configuration runs GPU CHW preprocessing, QNN HTP inference and GPU
per-frame P2/P98 normalization without range EMA or pixel history. Two bounded
capture leases preserve the exact source RGB and PTS until the matching depth is
ready. Submit the pair together; when busy, repeat the valid pair and reuse its SBS
render cache. Never combine stale depth with newer RGB in this configuration.
Seek/source/Surface generation changes invalidate pairs and render caches. GPU liquid
stretches background texture locally; it does not recover unseen scene content.
Host input readback and QNN output handoff remain: this is not zero-copy. Registered
full-model shared memory is independently benchmarked, not yet the product backend.

Controls/subtitles remain outside the warped layer. ASS/WebVTT prefer the paired
presentation position when valid; media reporting retains the Media3 clock. Audio has
no additional fixed delay compensation. Pair PTS agreement alone does not establish
AV synchronization or zero display latency. Known source PTS drives liquid sampling admission, resetting on generation changes or
backward media time; capture/worker durations retain a monotonic wall clock. Unknown
PTS uses the legacy wall-clock cadence. GPU liquid diffusion reuses an FP32 shared
neighborhood tile without changing iteration count or arithmetic.
A blocked liquid capture can retry only the still-latched frame with the same PTS and
generation and no pending newer decoder frame. Successful capture consumes the retry;
new frames/generations supersede it. This adds no buffer slots. Normalization submission
alone does not request a paired redraw; accepted pairs still do.
An opt-in `gpuPollOffMain` timer uses a dedicated HandlerThread; GL operations remain
on the GLSurfaceView queue with the same bounded, generation-checked observer. Close
cancels callbacks and quits the timer. Exported poll wake (including the requested
2 ms), GL queue and service durations measure host scheduling, not GPU execution.
The switch defaults off: sequential three-minute A/B/A runs showed only a small
uncontrolled difference; see [short comparison](performance/2026-09-15-gpu-poll-short/README.md).
Full production and liquid daily builds enable `captureBeforeLiquid`: after accepting the matching
RGB/depth and releasing its lease, attempt the existing bounded capture retry, then
submit the pair's liquid field immediately on the GL queue. Draw callbacks likewise
capture before submitting any pending field. A pair serial prevents duplicate field
submission; generation checks reject stale work, and rendering follows its field.
The exported first-pair-draw timings distinguish capture-to-draw-start from depth
acceptance. They do not include GPU completion or physical presentation.
See [capture-order short comparison](performance/2026-09-15-capture-order/README.md).
Target sampling is 24 Hz, not a guaranteed
presentation rate. The latest product long-run evidence and remaining recovery/compatibility checks are
listed in the current guide.

Native commands are limited to 16 KiB and URLs to 12 KiB, matching the active session's
scheme, host, port and Jellyfin `/Videos/` subpath. No arbitrary headers or local-file access.
Both session generation and playback token protect late commands and clock events.
Stop, logout and renderer loss release the engine; background releases codecs/backend,
then returning reopens at the stored position in a paused state. SessionRepository stays
the only account owner. Native 401/403 events use the existing unauthorized generation check.

Legacy CPU stabilization, temporal filtering, unpaired daily profiles and their opt-in
flags remain available as regression references. Their historical configuration and
measurements are [archived](archive/2026-09-14-realtime-sbs-builds.md); they do not
define the selected liquid route. Lite retains planar output; Full production rejects
overrides that conflict with the validated 392 liquid profile.

The existing phone diagnostic share includes whitelisted native playback samples: latest
120 entries, at most 1 Hz plus status/subtitle-error changes. Samples survive player teardown
within the same Activity/process, but not a force stop; already exported cache files are separate. Formats, decoder, numeric errors,
buffer/counters, subtitle delivery/error, depth age and pipeline timing are included;
URLs, tokens, media names, subtitle text and images are excluded. JVM tests cover this boundary.

## Verification

Desktop verification covers TypeScript, both production bundles, JVM tests,
Android lint, Debug/Release assembly, and APK inspection. Device acceptance
must additionally cover display attach/detach, USB grants, physical mode observation and timeout,
login/session restore/logout, browse and playback flows, remote focus,
renderer recovery, one audio/report stream, and the selected `MediaCodec`
component during representative playback.

Build commands and APK inspection details live in
[DEVELOPMENT.md](DEVELOPMENT.md#验证). The following matrix is the
minimum device regression set for any device-facing change.

### Device regression matrix

| Area | Required cases | Pass condition |
| --- | --- | --- |
| Install and lifecycle | First launch, cold launch, background/foreground, Activity recreation | Phone UI and glasses Presentation recover without a stale or duplicate session |
| Authentication | IPv4 discovery, manual hostname/IPv6 URL, Quick Connect, password login, remembered and non-persistent login | Exactly one validated session reaches the glasses; passwords never persist |
| Account management | Two servers, two users on one server, remembered/transient accounts, old-version migration, cold restart, failed/cancelled password and Quick Connect login | Switching reuses the selected login, resets old browsing/playback state, and failed/cancelled additions retain the original connection |
| Session cleanup | Logout, remove active/inactive account, restored `401`/`403`, late unauthorized event after switching | Only the affected account is forgotten; active cleanup clears bootstrap, pending commands, playback and both UIs together; other accounts remain usable |
| Display connection | Glasses attached before launch, attached after launch, disconnected and reconnected | The intended external display is selected and phone UI stays on the default display |
| Display modes | Confirmed Mirror 2D and stereo switch, USB permission denied, occupied interface, exception, physical output timeout | Consent waiting stays visible; only a hardware transition hides the WebView; failures end the transition without automatic retries, while OS-disabled output still requires system mirroring |
| SBS geometry | Command response/write before/after actual 3840×1080 output; same-ID resize; EDID display recreation; unsupported half-SBS/rotated/inset viewport | Stereo requires command and physical/View evidence; document/video survive a bounded transition; all four page edges and full playback controls remain visible after both switch directions; invalid output falls back once |
| System display availability | OS disables a recreated external display, enable inside/outside the transition deadline | The phone identifies disabled output, no false applied state or automatic retry loop; app fallback does not claim to enable an OS-disabled display |
| Startup consent | Saved SBS with disabled 1920×1080, already-SBS/unknown mode, saved 2D; grant/deny USB; repeated display events; enable mirroring before/after USB completion; change mode during consent; cold launch and attach with/without a default USB handler | At most one early SBS attempt, no duplicate command after a successful write, no applied mode before physical/View confirmation; denial/failure remains visible without retries; verify actual HyperOS prompt count and default-handler persistence on device |
| Virtual screen controls | Fixed 90% size at all four depth levels, then fixed depth at 80–95%; rapid edits; pause/resume; cold restart | Left/right offsets are ±d/2, average center and vertical alignment stay fixed, size is independent, full image stays in each eye and saved settings restore |
| Eye reference overlay | Close each eye alternately; compare baseline and increased disparity; leave settings, switch mode, disconnect, logout and kill renderer | Left eye sees L, right sees R; cyan plane moves closer relative to white reference, no persistent overlay after exit/recovery |
| Stereo video composition | Moving frame-number video with DOM controls and text subtitles in both modes, while changing depth/size | Both eyes receive the same frame, video/subtitles/DOM receive identical transforms, no frozen video, duplicate sound/reporting, clipped edge or cross-eye leakage |
| Browse and focus | Home, search, filters, folders, details, long lists, dialogs, remote back; partial episode exit, short session, multiple unfinished episodes, cross-season resume, first downward episode entry in both themes | Exactly one visible spatial focus target exists and overlays prevent background input |
| Controllers (device acceptance pending) | Bluetooth first; Xbox/PlayStation/Switch-style mappings, USB/receiver separately; D-pad key/HAT, stick drift/diagonals, held confirm/back, neutral/reconnect, phone input, both window focus paths, search IME, tutorial, direct/HLS controls, account/renderer/mode changes | One action per press, bounded repeats only while eligible, no stale replay or default double navigation; one glasses focus/player/reporting stream; source-based search autofocus behaves correctly |
| UI language | Chinese/English system, manual override, both surfaces, cold start/logout/reset, system locale change, renderer recovery and direct/HLS playback in 2D/SBS | Saved language agrees across surfaces; server metadata and subtitle content remain unchanged; no catalog reload, session switch, lost focus or duplicate WebView/video/audio/reporting |
| UI themes | Default install, saved simpleUI cold launch, rapid switches during browse/direct play/HLS/tutorial in both 2D and SBS, disconnect/reconnect, renderer recovery, logout, reset preferences | Both surfaces and phone system bars agree; focus, document, video, audio and reporting remain single-instance; theme survives logout/recovery and reset restores liquid-glass; simpleUI has no decorative loops or blur |
| Phone settings | Import/replace/cancel/reset wallpaper, malformed/oversized files, rotated photos, all crop ratios, zoom/position/opacity extremes, drag, save/cancel/Back, stale revision, cold launch, renderer recovery, theme changes, About links and installed version | Failed imports/cancelled edits retain the image and layout; saved crop restores; clear resets layout; only Liquid phone pages render it; wallpaper edits preserve glasses/video; source metadata stays private; links open fixed public pages outside the WebView; version matches the APK |
| Remote background | Both themes, texture/black selection, cold launch, gestures, search/IME, playback panels and returning to settings | Choice persists without changing session/video; blank black regions and system-bar backgrounds measure RGB 0,0,0 in a lossless screenshot; no glow/texture/overscroll scrim; controls remain visible |
| Liquid glass transparency | Default/custom wallpaper, 0/88/100%, mixed dark/light photos, expanded settings, scrolling navigation, rapid edits, reload, theme switches, reset and account changes | Card/nav fill follows the saved value without fading text; local text color accounts for stacked glass; the solid touch key covers the navigation rim; reset restores 88 and glasses/video/black remote remain unchanged |
| Glasses settings and subtitle size | Enter/exit glasses Settings, both themes and four sizes, phone/glasses edits, paused/direct/HLS playback, text versus burned-in subtitles, cold launch/logout/reset in 2D and SBS | One focus returns to Settings; both surfaces acknowledge the same saved preference; playback uses the chosen text size with no font controls in player menus, duplicate video or reporting |
| Remote tutorial | First ready catalog, skip/relaunch, six phone gestures, wrong/rapid input, pause/resume/exit, sidebar replay, logout, 2D/SBS switch and renderer recovery | Each real gesture advances once; exactly one focus stays inside practice/dialog; completion or skipping is remembered; no media playback or background navigation; SVG motion and text remain readable in both eyes |
| Glasses UI sounds | Direction/confirm/back, held input at a focus boundary, panels, volume, tutorial and feedback; mute/unmute during a cue; cold launch, logout, detach/reattach, renderer recovery, both themes and display modes, direct/HLS playback | Each ordinary gesture triggers at most one immediate cue and a held direction sounds once at the same boundary; mute persists and stops active/pending cues; the player is silent except for volume; no startup/restoration cue or phone UI sounds; video soundtrack/volume/reporting are unchanged and stereo does not duplicate cues |
| Playback | Horizontal preview while progress focused (short ten-second swipes, fixed-distance drag, reversal and resting finger, bounds, full phone slider, single commit on release, paused state, cancel, multi-touch, blur, panels, expiry and reconnect); Direct play, H.264/AAC HLS fallback, pause, seek, previous/next item, audio track, WebVTT, ASS/SSA and bitmap subtitles; ASS animated positioning/karaoke, attached/missing fonts, rapid ASS→text→off, paused seek, worker failure and logout in 2D/SBS | Playback remains controllable, progress is reported once, and the selected track is reflected in UI |
| Single-instance invariants | Mirror and stereo during representative playback | One glasses WebView, zero HTML `<video>`, one native player, one audio stream, and one Jellyfin reporting stream remain active |
| Renderer recovery | Kill or crash the glasses WebView renderer during browse and playback | The WebView is rebuilt, session bootstrap is republished, and the phone receives a safe state |
| Codec selection | Representative H.264, HEVC/VP9/AV1 where hardware advertises support, plus an unsupported source | The actual Media3 `MediaCodec` component matches expectations; incompatible media requests the bounded HLS fallback |
| Field diagnostics | Network, HTTP, response, and unknown failures; Android share flow | The phone shows the correct fixed category and the exported report contains no URL, account, title, code, token, password, body, or arbitrary exception text |

Language state, localization boundaries and message maintenance are documented in [I18N.md](I18N.md).
