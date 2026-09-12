export function depthIndex(frame, profile, count) {
    return Math.min(count - 1, Math.max(0, Math.floor((frame - profile.delay) / profile.stride)));
}
export function shuffle(values, random = Math.random) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
export function validScore(value) { return Number.isInteger(value) && value >= 1 && value <= 5; }
