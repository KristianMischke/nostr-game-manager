/**
 * NIP-GM event kinds (the 2600 family, after the Atari 2600).
 *
 * Kind numbers are placeholders pending NIP review — see NIP-GM §Open Questions.
 * Everything routes through these constants so a reallocation is one edit.
 */

/** Offset between a regular kind and its ephemeral mirror. */
export const EPHEMERAL_OFFSET = 19000;

export const KIND = {
  /** addressable, GM — one per supported game; `d` = game module id. */
  GM_ANNOUNCEMENT: 32600,
  /** addressable, GM — `d` = lobby id. */
  LOBBY: 32601,
  /** addressable, GM — latest full snapshot; `d` = game id. */
  GAME_HEAD: 32602,
  /** ephemeral, any — discovery request and offer. */
  DISCOVERY: 21602,

  /** regular, player or GM — game message (actions and responses). */
  MESSAGE: 2600,
  /** ephemeral mirror of MESSAGE, used in `casual` mode. */
  MESSAGE_EPHEMERAL: 21600,

  /** regular, GM — game state (lifecycle, deltas, private state). */
  STATE: 2601,
  /** ephemeral mirror of STATE, used in `casual` mode. */
  STATE_EPHEMERAL: 21601,
} as const;

export type Kind = (typeof KIND)[keyof typeof KIND];

/** Persistence mode for a lobby — selects regular vs ephemeral kinds. */
export type PersistenceMode = 'verified' | 'casual';

/** The ephemeral mirror of a mirrored regular kind. */
export function ephemeralOf(kind: number): number {
  return kind + EPHEMERAL_OFFSET;
}

/** The regular kind behind an ephemeral mirror. */
export function regularOf(kind: number): number {
  return kind - EPHEMERAL_OFFSET;
}

/**
 * The message kind to use in a given persistence mode.
 * NIP-GM §Persistence Modes.
 */
export function messageKind(mode: PersistenceMode): number {
  return mode === 'casual' ? KIND.MESSAGE_EPHEMERAL : KIND.MESSAGE;
}

/**
 * The state kind to use in a given persistence mode.
 *
 * Caution: lifecycle events (`start`, `end`, `abort`) are ALWAYS published on
 * the regular kind even in `casual` mode, so that every game leaves a minimal
 * permanent record. Use {@link stateKindFor} rather than this function when the
 * state subtype is known.
 */
export function stateKind(mode: PersistenceMode): number {
  return mode === 'casual' ? KIND.STATE_EPHEMERAL : KIND.STATE;
}

/** State event subtypes, carried in the non-indexed `state` tag. */
export type StateType = 'start' | 'delta' | 'private' | 'end' | 'abort';

/** Subtypes that are always persistent, regardless of mode (NIP-GM §End and abort). */
const ALWAYS_REGULAR: ReadonlySet<StateType> = new Set<StateType>(['start', 'end', 'abort']);

/**
 * The state kind for a specific subtype in a given mode, honouring the rule
 * that lifecycle events stay on the regular kind even in `casual` mode.
 */
export function stateKindFor(mode: PersistenceMode, type: StateType): number {
  if (ALWAYS_REGULAR.has(type)) return KIND.STATE;
  return stateKind(mode);
}

/** Both kinds a game's events may appear on, for building subscription filters. */
export function gameKinds(mode: PersistenceMode): number[] {
  return mode === 'casual'
    ? [KIND.MESSAGE_EPHEMERAL, KIND.STATE_EPHEMERAL, KIND.STATE]
    : [KIND.MESSAGE, KIND.STATE];
}
