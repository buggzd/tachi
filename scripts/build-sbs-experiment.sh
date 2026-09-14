#!/usr/bin/env bash
set -euo pipefail
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PROFILE="${1:-quality}"
case "${PROFILE}" in
    quality) resolution=518; hz=12 ;;
    motion) resolution=392; hz=24 ;;
    liquid) resolution=392; hz=24 ;;
    *) echo 'Usage: build-sbs-experiment.sh [quality|motion|liquid]' >&2; exit 2 ;;
esac
cd "${ROOT}"
AndroidApp/gradlew -p AndroidApp -PdailySbs="${PROFILE}" -PrealtimeSbs=true \
    -PalignedLiquid="$([[ ${PROFILE} == liquid ]] && echo true || echo false)" -PdepthResolution="${resolution}" -PdepthHz="${hz}" -PcaptureSlots=2 \
    -PgpuDepthStabilization=true -PgpuPreprocess=true -PpinnedDepthOutput=true -PasyncCapturePoll=true \
    :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :native-video:testDebugUnitTest :native-video:lintDebug
scripts/verify-android.sh
mkdir -p AndroidApp/app/build/distributions
cp AndroidApp/app/build/outputs/apk/debug/app-debug.apk "AndroidApp/app/build/distributions/tachi-sbs-${PROFILE}-${resolution}.apk"
echo "Created tachi-sbs-${PROFILE}-${resolution}.apk (development app ID, non-debuggable)"
