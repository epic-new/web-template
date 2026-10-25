"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { useRefreshReplayPolicy } from "@/app/api/epic/replay/config/behaviors/refresh-replay-policy/use-refresh-replay-policy.hook";
import { replayIdentityBoundaryPending, subscribeReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import type { ReplayRootOptions, ReplayRootRuntime } from "@/lib/replay/replay-root-runtime";

type RuntimeModule = typeof import("@/lib/replay/replay-root-runtime");
interface Attachment { setRuntime: (runtime: ReplayRootRuntime) => void; detach?: () => void }
interface DocumentHost {
  options: Pick<ReplayRootOptions, "documentRelease" | "lifecycle">;
  runtime: ReplayRootRuntime | null;
  loading: Promise<RuntimeModule> | null;
  attachments: Set<Attachment>;
  identity: string | null | undefined;
  pendingIdentity: boolean;
  refreshEpoch: number;
  refreshController: AbortController | null;
  stopIdentity?: () => void;
}
const HOSTS_KEY = Symbol.for("epic.replay.document-hosts.v1");
function hosts(): WeakMap<Document, DocumentHost> {
  const host = globalThis as typeof globalThis & { [HOSTS_KEY]?: WeakMap<Document, DocumentHost> };
  return host[HOSTS_KEY] ??= new WeakMap();
}

function refreshIdentity(host: DocumentHost) {
  const run = ++host.refreshEpoch;
  host.refreshController?.abort();
  const controller = new AbortController();
  host.refreshController = controller;
  host.pendingIdentity = true;
  if (replayIdentityBoundaryPending()) { host.runtime?.beginIdentityChange(); return; }
  host.runtime?.beginIdentityRevalidation();
  const fail = () => {
    if (run !== host.refreshEpoch || !host.attachments.size) return;
    host.identity = undefined;
    host.runtime?.failIdentityRevalidation();
  };
  const deadline = setTimeout(() => { controller.abort(); fail(); }, 12_000);
  void authClient.getSession({ fetchOptions: { signal: controller.signal } }).then((result) => {
    if (run !== host.refreshEpoch || controller.signal.aborted || !host.attachments.size) return;
    if (result.error) { fail(); return; }
    host.identity = result.data?.user.id ?? null;
    host.pendingIdentity = false;
    host.runtime?.setIdentity(host.identity);
  }).catch(fail)
    .finally(() => { clearTimeout(deadline); });
}

function watchIdentity(host: DocumentHost) {
  // Clock drift and document resume also gate the existing policy owner, even
  // when the browser emits neither focus nor visibility restoration.
  const stopGate = replayLifecycle.subscribeGate(() => { if (!host.pendingIdentity) refreshIdentity(host); });
  const unsubscribe = subscribeReplayIdentityBoundary((event) => {
    if (event.phase === "begin") {
      host.refreshEpoch++;
      host.refreshController?.abort();
      host.pendingIdentity = true;
      host.identity = undefined;
      host.runtime?.beginIdentityChange();
    } else refreshIdentity(host);
  });
  const focus = (event: FocusEvent) => {
    // Capture also observes focus moving to controls inside the document.
    // Only returning to the window needs identity revalidation.
    if (event.target === event.currentTarget) refreshIdentity(host);
  };
  let wasHidden = document.visibilityState === "hidden";
  const visibility = () => {
    if (document.visibilityState === "hidden") wasHidden = true;
    else if (wasHidden) { wasHidden = false; refreshIdentity(host); }
  };
  const show = (event: PageTransitionEvent) => { if (event.persisted) refreshIdentity(host); };
  // Pause before the policy hook's bubble listeners withhold its old receipt.
  // A pending same-subject refresh retains only a clean, owned frontier.
  window.addEventListener("focus", focus, true);
  document.addEventListener("visibilitychange", visibility, true);
  window.addEventListener("pageshow", show, true);
  return () => {
    host.refreshEpoch++;
    host.refreshController?.abort();
    unsubscribe();
    stopGate();
    window.removeEventListener("focus", focus, true);
    document.removeEventListener("visibilitychange", visibility, true);
    window.removeEventListener("pageshow", show, true);
  };
}

/** The only policy loader and auth observer in canonical root composition. */
export function useInitializeEpicReplay(options: Pick<ReplayRootOptions, "documentRelease" | "lifecycle">) {
  useRefreshReplayPolicy();
  const session = authClient.useSession();
  const key = session.isPending || session.error ? undefined : session.data?.user.id ?? null;
  const identity = useRef<string | null | undefined>(key);
  const hostRef = useRef<DocumentHost | null>(null);
  const initialOptions = useRef({ documentRelease: options.documentRelease,
    lifecycle: options.lifecycle ? { ...options.lifecycle } : undefined });
  const [runtime, setRuntime] = useState<ReplayRootRuntime | null>(null);

  // Layout timing stops a changed external session before rrweb's MutationObserver
  // admits the new account DOM. Explicit auth entry paths also stop synchronously.
  useLayoutEffect(() => {
    identity.current = key;
    const host = hostRef.current;
    if (!host) return;
    if (session.error) {
      // The manager may still be importing. Revoke the host's cached identity
      // too, and prevent an older refresh from restoring it after this failure.
      host.refreshEpoch++;
      host.refreshController?.abort();
      host.pendingIdentity = false;
      host.identity = undefined;
      host.runtime?.failIdentityRevalidation();
      return;
    }
    if (host.pendingIdentity) {
      // An observed account switch supersedes an older refresh. An explicit
      // auth operation must settle through its barrier before any identity wins.
      if (key === undefined || host.identity === undefined || key === host.identity || replayIdentityBoundaryPending()) return;
      host.refreshEpoch++;
      host.refreshController?.abort();
      host.pendingIdentity = false;
    }
    host.identity = key;
    host.runtime?.setIdentity(key);
  }, [key, session.error]);

  useEffect(() => {
    let host = hosts().get(document);
    if (!host) {
      host = { options: initialOptions.current, runtime: null, loading: null, attachments: new Set(),
        identity: identity.current, pendingIdentity: false, refreshEpoch: 0, refreshController: null };
      hosts().set(document, host);
    }
    const current = host;
    hostRef.current = current;
    const attachment: Attachment = { setRuntime };
    current.attachments.add(attachment);
    if (!current.stopIdentity) current.stopIdentity = watchIdentity(current);
    if (replayIdentityBoundaryPending()) {
      current.pendingIdentity = true;
      current.identity = undefined;
      current.runtime?.beginIdentityChange();
    } else if (current.pendingIdentity) refreshIdentity(current);
    else current.identity = identity.current;

    const attach = () => {
      if (!current.runtime || !current.attachments.has(attachment)) return;
      current.runtime.setIdentity(current.pendingIdentity ? undefined : current.identity);
      attachment.detach = current.runtime.attach();
      attachment.setRuntime(current.runtime);
    };
    if (current.runtime) attach();
    else {
      current.loading ??= import("@/lib/replay/replay-root-runtime");
      void current.loading.then((loaded) => {
        if (!current.attachments.has(attachment)) return;
        current.runtime ??= loaded.createReplayRootRuntime(current.options);
        attach();
      }).catch(() => { /* Optional runtime loading never interrupts rendering. */ });
    }
    return () => {
      current.attachments.delete(attachment);
      attachment.detach?.(); // Last detach cancels capture immediately, including pending imports.
      hostRef.current = null;
      if (!current.attachments.size) {
        current.stopIdentity?.();
        current.stopIdentity = undefined;
      }
      // Keep the document's immutable release/recovery state through React remounts.
      // A true new document gets a distinct WeakMap key and manager.
    };
  }, []);
  return runtime;
}
