"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { ReplayConsentBanner } from "@/components/replay-consent-banner";
import { ReplayReportButton } from "@/components/replay-report-button";
import { authClient } from "@/lib/auth/client";
import { disabledReplayConfig } from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import {
  createReplayRecordingPipeline,
  type ReplayPipelineState,
  type ReplayRecordingPipeline,
} from "@/lib/replay/replay-recording-pipeline";
import {
  REPLAY_UPLOAD_CONTRACT_VERSION,
  replayUploadErrorBodySchema,
  type ReplayUploadErrorCode,
} from "@/lib/replay/replay-upload-contract";
import { EpicReplayContext, type EpicReplay, type EpicReplayStatus } from "@/lib/replay/use-epic-replay";

const serverPolicy = disabledReplayConfig({ reason: "unavailable", environment: null, release: null, now: 0 });
const IDENTITY_ATTEMPTS = 3;

type Identity = { state: "pending" } | { state: "ready" } | { state: "failed"; code: ReplayUploadErrorCode };

async function sendIdentity(method: "POST" | "DELETE"): Promise<{ ok: true } | { ok: false; code: ReplayUploadErrorCode }> {
  try {
    const response = await fetch("/api/epic/replay/identity", {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ contractVersion: REPLAY_UPLOAD_CONTRACT_VERSION, ...(method === "POST" ? { purpose: "capture" } : {}) }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.ok) return { ok: true };
    const error = replayUploadErrorBodySchema.safeParse(await response.json().catch(() => undefined));
    return { ok: false, code: error.success ? error.data.code : "unavailable" };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

// Only a transient failure is worth another attempt; a refusal is final.
async function acknowledgeIdentity(isCancelled: () => boolean) {
  let result: Awaited<ReturnType<typeof sendIdentity>> = { ok: false, code: "unavailable" };
  for (let attempt = 0; attempt < IDENTITY_ATTEMPTS && !isCancelled(); attempt++) {
    result = await sendIdentity("POST");
    if (result.ok || result.code !== "unavailable") return result;
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  return result;
}

function statusOf(pipeline: ReplayPipelineState | null, identity: Identity, armed: boolean): Pick<EpicReplay, "status" | "reason"> {
  if (!armed) return { status: "disabled", reason: null };
  if (identity.state === "failed") return { status: "unavailable", reason: identity.code };
  if (!pipeline || identity.state === "pending") return { status: "waiting", reason: null };
  if (pipeline.upload.status === "unavailable") return { status: "unavailable", reason: pipeline.upload.reason };
  if (pipeline.capture.status === "blocked") return { status: "waiting", reason: pipeline.capture.reason };
  return { status: "recording" as EpicReplayStatus, reason: pipeline.upload.reason };
}

/**
 * The one root integration for Epic Replay. It starts the recording pipeline
 * once capture is enabled by the runtime policy and the identity is
 * acknowledged, and disposes it on unmount or an account change. Consent,
 * route eligibility and sampling stay with the capture session, so nothing
 * records until the host grants consent. Nothing here can break the host app:
 * every failure only changes `useEpicReplay()`.
 *
 * `release` is the immutable build identity of this document, taken from the
 * server-rendered root layout. It is sent as `service.version` on every record
 * and never replaced by a later policy refresh.
 */
export function EpicReplayProvider({
  release = null,
  anonymousCapture = false,
  anonymousReporting = false,
  children,
}: {
  release?: string | null;
  /** Whether this server records signed-out visitors (`EPIC_REPLAY_ANONYMOUS_CAPTURE`). */
  anonymousCapture?: boolean;
  /** Whether this server accepts reports from signed-out visitors (`EPIC_REPLAY_ANONYMOUS_REPORTING`). */
  anonymousReporting?: boolean;
  children: ReactNode;
}) {
  const policy = useSyncExternalStore(replayLifecycle.subscribe, replayLifecycle.getSnapshot, () => serverPolicy);
  const session = authClient.useSession();
  const userId = session.data?.user?.id ?? null;
  const identityPending = session.isPending;
  const pathname = usePathname();
  const refetchSession = session.refetch;

  // Sign-in, sign-up and sign-out are server actions that redirect, so the
  // client session store never hears about them: re-read it on every
  // navigation, which is what changes the subject a recording belongs to.
  useEffect(() => {
    void refetchSession();
  }, [pathname, refetchSession]);

  // Once capture has been enabled for this page it stays armed: the capture
  // session blocks and resumes by policy, so a refresh gap does not tear the
  // pipeline down and re-register.
  const [armed, setArmed] = useState(false);
  if (!armed && policy.status === "active" && policy.capture.enabled) setArmed(true);

  const [identity, setIdentity] = useState<Identity>({ state: "pending" });
  const [pipelineState, setPipelineState] = useState<ReplayPipelineState | null>(null);
  const pipelineRef = useRef<ReplayRecordingPipeline | null>(null);
  const lastUserRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!armed || identityPending) return;
    let cancelled = false;
    let pipeline: ReplayRecordingPipeline | null = null;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      setIdentity({ state: "pending" });
      // An actual account change clears the previous anonymous visitor first.
      const previous = lastUserRef.current;
      lastUserRef.current = userId;
      if (previous !== undefined && previous !== userId) await sendIdentity("DELETE");
      const acknowledged = await acknowledgeIdentity(() => cancelled);
      if (cancelled) return;
      if (!acknowledged.ok) {
        setIdentity({ state: "failed", code: acknowledged.code });
        return;
      }
      setIdentity({ state: "ready" });

      pipeline = createReplayRecordingPipeline({ getDocumentRelease: () => release });
      pipelineRef.current = pipeline;
      setPipelineState(pipeline.getState());
      unsubscribe = pipeline.subscribe(() => setPipelineState(pipeline!.getState()));
      pipeline.start();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      pipeline?.dispose();
      if (pipelineRef.current === pipeline) pipelineRef.current = null;
      setPipelineState(null);
    };
  }, [armed, identityPending, userId, release]);

  // A signed-out visitor is offered the button only where their report would be accepted.
  const reportingEnabled =
    policy.status === "active" && policy.reporting.enabled && (Boolean(userId) || anonymousReporting);

  const value = useMemo<EpicReplay>(() => {
    const { status, reason } = statusOf(pipelineState, identity, armed);
    return {
      status,
      reason,
      capture: pipelineState?.capture ?? null,
      upload: pipelineState?.upload ?? null,
      evidence: "unverified",
      reporting: { enabled: reportingEnabled },
      getSessionReference: () => pipelineRef.current?.getSessionReference() ?? null,
      flush: () => pipelineRef.current?.flush().catch(() => undefined) ?? Promise.resolve(),
      event: (name, payload) =>
        pipelineRef.current?.event(name, payload) ?? { recorded: false, reason: "not_recording" },
    };
  }, [pipelineState, identity, armed, reportingEnabled]);

  return (
    <EpicReplayContext.Provider value={value}>
      {children}
      {/* Consent is asked only where a recording could actually follow. */}
      {armed && (userId || anonymousCapture) ? <ReplayConsentBanner /> : null}
      {reportingEnabled ? <ReplayReportButton release={release} /> : null}
    </EpicReplayContext.Provider>
  );
}
