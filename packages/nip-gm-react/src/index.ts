export * from './use-store.js';

/**
 * Still to come (milestone 7):
 *   provider.tsx    <GameProvider client={...}> — context carries the CLIENT, never the state
 *   use-game.ts     useGame<S>(gameId) -> GameSnapshot<S>
 *   use-lobby.ts    useLobby(addr), useLobbies(filter)
 *   use-move.ts     useSubmitMove(gameId) -> { submit, pending, error }
 */
