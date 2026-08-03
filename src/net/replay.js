// Pure helpers for the instant-replay buffer, split out of the component so
// the ordering guarantee Package 5 depends on is unit-testable without React
// (see CLAUDE.md: "no component-test setup ... move the logic out of it").
//
// A remote turn's wire payload carries `replay`: the frames for whatever
// already happened before this client saw the state (the partner's move,
// plus any AI moves the *other* client simulated on the way). On adopting a
// state, this client seeds its local buffer from those wire frames, then may
// itself simulate more AI seats (§4.2) and append its own frames. The
// contract that matters: wire frames always play first, exactly in the order
// they arrived, and anything this client adds is appended strictly after —
// never interleaved and never reordered.

// Seed a fresh replay buffer from a state's wire frames. Defensive against a
// missing/non-array `replay` (a fresh join, or a pre-Package-4 payload).
export function seedReplay(wireFrames) {
  return Array.isArray(wireFrames) ? [...wireFrames] : [];
}

// Append a locally-simulated frame (an AI move this client just ran) after
// whatever is already buffered, preserving order.
export function appendReplayFrame(frames, frame) {
  return [...frames, frame];
}
