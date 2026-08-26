/**
 * SSE consumer for a turn.
 *
 * fetch + ReadableStream rather than EventSource, because a turn is a POST.
 * Deliberately thin: the controller already speaks TurnEvent, so there is no
 * translation layer — what the agent's directory did is what arrives here.
 */
import type { TurnEvent } from "@perpetual/shared/events";
import type { Anchor } from "@perpetual/shared/site";

export type WireEvent =
  | TurnEvent
  | { type: "turn_saved"; pages: number; answered: Record<string, string> };

export async function* runTurn(
  sessionId: string, input: string, anchor?: Anchor, signal?: AbortSignal,
): AsyncIterable<WireEvent> {
  const res = await fetch(`/sessions/${sessionId}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The anchor rides with the question: which page, and which block the
    // reader was looking at when they asked.
    body: JSON.stringify({ input, ...(anchor ? { anchor } : {}) }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    yield { type: "error", message: (err as { error?: string }).error ?? `HTTP ${res.status}` };
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep: number;
    // Frames are separated by a blank line and may straddle chunks.
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6)) as WireEvent;
    }
  }
}
