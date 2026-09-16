# Release JNI device probe

This is a separate instrumentation APK, never packaged in tachi. It targets the
installed, non-debuggable official application and must use the same signing
certificate. It compiles against the pinned ORT AAR's `classes.jar`, but packages
only its own probe DEX; all ORT Java classes, native libraries and the model come
from the installed Release. No accounts or media are read.

With an Android 35 SDK, compile `JniProbe.java` against `android.jar` and the AAR's
`classes.jar`, use build-tools 34.0.0 `d8` with min-api 30, and package the resulting
`classes.dex` with this manifest using `aapt`. Sign that separate APK using the
existing release certificate, passing passwords through environment variables.
Do not put the runtime AAR/classes into the test APK: that would mask R8 defects.

After explicitly allowing its installation on the device:

```bash
adb install -r /path/to/probe.apk
adb shell am instrument -w com.jellyfinforrayneo.releaseprobe/.JniProbe
```

A pass requires native output-metadata lookup and three pinned-output QNN runs
without CPU fallback, with finite output. The probe uses the fixed SM8850/V81,
392×224 production contract. It is not a test of video capture, liquid rendering,
audio, subtitles or display recovery: actual Release playback must also pass.
Instrumentation can restart the target process; do not run during user playback.
Device installation denials must be resolved by the user, not bypassed.

The helper contains no stored data and may be uninstalled after testing. Never
publish its APK or the signing inputs as release assets.
