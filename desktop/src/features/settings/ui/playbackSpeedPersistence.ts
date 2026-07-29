type MutableValue<T> = {
  current: T;
};

export type PlaybackSpeedPersistenceState = {
  active: MutableValue<boolean>;
  confirmedSpeed: MutableValue<number>;
  desiredSpeed: MutableValue<number>;
  flushPromise: MutableValue<Promise<void> | null>;
  hasLocalIntent: MutableValue<boolean>;
};

type PlaybackSpeedPersistenceCallbacks = {
  persist: (speed: number) => Promise<void>;
  setSpeed: (speed: number) => void;
  setError: (error: string | null) => void;
};

export function commitPlaybackSpeed(
  state: PlaybackSpeedPersistenceState,
  callbacks: PlaybackSpeedPersistenceCallbacks,
  nextSpeed: number,
) {
  if (!state.active.current) return;
  state.hasLocalIntent.current = true;
  state.desiredSpeed.current = nextSpeed;
  callbacks.setSpeed(nextSpeed);
  callbacks.setError(null);
  ensurePlaybackSpeedFlush(state, callbacks);
}

export function cancelPlaybackSpeedPersistence(
  state: PlaybackSpeedPersistenceState,
) {
  state.active.current = false;
}

export function applyLoadedPlaybackSpeed(
  state: PlaybackSpeedPersistenceState,
  callbacks: Pick<PlaybackSpeedPersistenceCallbacks, "setSpeed">,
  savedSpeed: number,
) {
  if (state.hasLocalIntent.current) return;
  state.confirmedSpeed.current = savedSpeed;
  state.desiredSpeed.current = savedSpeed;
  callbacks.setSpeed(savedSpeed);
}

function ensurePlaybackSpeedFlush(
  state: PlaybackSpeedPersistenceState,
  callbacks: PlaybackSpeedPersistenceCallbacks,
) {
  if (!state.active.current || state.flushPromise.current) return;

  const flush = flushPlaybackSpeed(state, callbacks).finally(() => {
    if (state.flushPromise.current !== flush) return;
    state.flushPromise.current = null;
    if (
      state.active.current &&
      state.desiredSpeed.current !== state.confirmedSpeed.current
    ) {
      ensurePlaybackSpeedFlush(state, callbacks);
    }
  });
  state.flushPromise.current = flush;
}

async function flushPlaybackSpeed(
  state: PlaybackSpeedPersistenceState,
  callbacks: PlaybackSpeedPersistenceCallbacks,
) {
  while (
    state.active.current &&
    state.desiredSpeed.current !== state.confirmedSpeed.current
  ) {
    const target = state.desiredSpeed.current;
    try {
      await callbacks.persist(target);
      if (!state.active.current) return;
      state.confirmedSpeed.current = target;
    } catch (cause) {
      if (!state.active.current) return;
      if (state.desiredSpeed.current === target) {
        state.desiredSpeed.current = state.confirmedSpeed.current;
        callbacks.setSpeed(state.confirmedSpeed.current);
        callbacks.setError(String(cause));
        return;
      }
    }
  }
}
