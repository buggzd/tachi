export function parseSeekCommand(value: unknown): number | null
export type ScrubMessage = { phase: 'start' | 'cancel' | 'preview' | 'commit'; id: string; position: number | null }
export type SeekPreviewState = { id: string; origin: number; target: number; updated: number }
export function parseScrubCommand(value: unknown): ScrubMessage | null
export class SeekPreview {
  active: SeekPreviewState | null
  reset(): void
  receive(command: string, current: number, duration: number, now: number): number | null
}
