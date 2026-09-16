#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly BUILD_VARIANT="${1:-debug}"
readonly SBS_VARIANT="${2:-lite}"
default_resolution=266
[[ "${SBS_VARIANT}" != full ]] || default_resolution=392
readonly DEPTH_RESOLUTION="${3:-${default_resolution}}"
case "${DEPTH_RESOLUTION}" in
    266|392) ;;
    *) echo "Depth resolution must be 266 (Lite) or 392 (Full)" >&2; exit 2 ;;
esac
if [[ "${SBS_VARIANT}" == lite && "${DEPTH_RESOLUTION}" != 266 ]]; then
    echo "Lite does not package a depth model; omit the resolution argument" >&2; exit 2
fi
if [[ "${SBS_VARIANT}" == full && "${DEPTH_RESOLUTION}" != 392 ]]; then
    echo "Full production requires the validated 392 liquid profile" >&2; exit 2
fi
case "${SBS_VARIANT}" in
    lite) realtime_sbs=false ;;
    full) realtime_sbs=true ;;
    *) echo "SBS variant must be lite or full" >&2; exit 2 ;;
esac

case "${BUILD_VARIANT}" in
    debug|release|all)
        ;;
    *)
        echo "Usage: $0 [debug|release|all] [lite|full] [266|392]" >&2
        exit 2
        ;;
esac

if [[ -z "${ANDROID_HOME:-}" \
        && -z "${ANDROID_SDK_ROOT:-}" \
        && ! -f "${PROJECT_DIR}/AndroidApp/local.properties" ]]; then
    echo "Android SDK not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or create AndroidApp/local.properties." >&2
    exit 1
fi

cd "${PROJECT_DIR}"
python3 -B -m unittest discover -s scripts/tests
npm --prefix GlassesUI ci
npm --prefix CompanionUI ci
npm --prefix GlassesUI run check
npm --prefix GlassesUI test
npm --prefix CompanionUI test
cd AndroidApp

# Incremental ZIP updates can retain unreferenced bytes from the previous model variant.
# Recreate the selected APK containers so Lite is small on disk, not just empty in its ZIP index.
for apk_kind in debug release; do
    if [[ "${BUILD_VARIANT}" == "${apk_kind}" || "${BUILD_VARIANT}" == all ]]; then
        rm -f "app/build/outputs/apk/${apk_kind}/app-${apk_kind}.apk" \
            "app/build/outputs/apk/${apk_kind}/app-${apk_kind}-unsigned.apk"
    fi
done

case "${BUILD_VARIANT}" in
    debug)
        ./gradlew -PrealtimeSbs="${realtime_sbs}" -PdepthResolution="${DEPTH_RESOLUTION}" :native-video:testDebugUnitTest :native-video:lintDebug :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
        ;;
    release)
        ./gradlew -PrealtimeSbs="${realtime_sbs}" -PdepthResolution="${DEPTH_RESOLUTION}" :native-video:testDebugUnitTest :native-video:lintDebug :app:testDebugUnitTest :app:lintRelease :app:assembleRelease
        ;;
    all)
        ./gradlew -PrealtimeSbs="${realtime_sbs}" -PdepthResolution="${DEPTH_RESOLUTION}" :native-video:testDebugUnitTest :native-video:lintDebug \
            :app:testDebugUnitTest \
            :app:lintDebug \
            :app:lintRelease \
            :app:assembleDebug \
            :app:assembleRelease
        ;;
esac

if [[ "${BUILD_VARIANT}" == debug || "${BUILD_VARIANT}" == all ]]; then
    "${SCRIPT_DIR}/verify-android.sh" \
        "AndroidApp/app/build/outputs/apk/debug/app-debug.apk"
    python3 "${SCRIPT_DIR}/realtime-sbs-bundle.py" verify-apk app/build/outputs/apk/debug/app-debug.apk --variant "${SBS_VARIANT}" --resolution "${DEPTH_RESOLUTION}"
fi

if [[ "${BUILD_VARIANT}" == release || "${BUILD_VARIANT}" == all ]]; then
    release_apk="AndroidApp/app/build/outputs/apk/release/app-release-unsigned.apk"
    if [[ -f "${PROJECT_DIR}/AndroidApp/keystore.properties" \
            || ( -n "${ANDROID_KEYSTORE_PATH:-}" \
                && -n "${ANDROID_KEYSTORE_PASSWORD:-}" \
                && -n "${ANDROID_KEY_ALIAS:-}" \
                && -n "${ANDROID_KEY_PASSWORD:-}" ) ]]; then
        release_apk="AndroidApp/app/build/outputs/apk/release/app-release.apk"
    fi
    "${SCRIPT_DIR}/verify-android.sh" "${release_apk}"
    python3 "${SCRIPT_DIR}/realtime-sbs-bundle.py" verify-apk "${PROJECT_DIR}/${release_apk}" --variant "${SBS_VARIANT}" --resolution "${DEPTH_RESOLUTION}"
    if [[ "${SBS_VARIANT}" == full ]]; then
        python3 "${SCRIPT_DIR}/verify-ort-jni.py" app/build/outputs/mapping/release
    fi
fi
