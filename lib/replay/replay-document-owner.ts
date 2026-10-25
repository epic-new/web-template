/** One cooperative recorder owner in this document, including development harnesses. */
export function createReplayDocumentOwners() {
  let owner: { name: "root" | "harness"; stop: () => void; token: object } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    getOwner: () => owner?.name ?? null,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquire(name: "root" | "harness", stop: () => void): (() => void) | null {
      if (name === "root" && owner) return null;
      const old = owner;
      const token = {};
      owner = { name, stop, token };
      try { old?.stop(); } catch { /* Detached old owner cannot interrupt the host. */ }
      emit();
      return () => {
        if (owner?.token !== token) return;
        owner = null;
        emit();
      };
    },
  };
}

const OWNER_KEY = Symbol.for("epic.replay.document-owners.v1");
export function replayDocumentOwners(): ReturnType<typeof createReplayDocumentOwners> {
  const host = globalThis as typeof globalThis & { [OWNER_KEY]?: ReturnType<typeof createReplayDocumentOwners> };
  return host[OWNER_KEY] ??= createReplayDocumentOwners();
}
