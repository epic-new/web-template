"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MessageSquareWarningIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSubmitReplayReport } from "@/app/api/epic/replay/reports/behaviors/submit-replay-report/use-submit-replay-report.hook";
import {
  REPLAY_REPORT_TEXT_MAX,
  toReplayPathname,
  type ReplayReportEvidence,
  type ReplayReportRequest,
  type ReplayUploadErrorCode,
} from "@/lib/replay/replay-upload-contract";
import { disabledReplayConfig } from "@/lib/replay/replay-config.contract";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { chooseReplayConsent } from "@/lib/replay/replay-consent-choice";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { useEpicReplay } from "@/lib/replay/use-epic-replay";

const serverPolicy = disabledReplayConfig({ reason: "unavailable", environment: null, release: null, now: 0 });

const COPY = {
  trigger: "Report a problem",
  title: "Report a problem",
  descriptionEvidence: "Tell us what went wrong. A reference to this session is attached and the recording may take a moment to become available.",
  descriptionAbsent: "Tell us what went wrong. No session is attached to this report.",
  what: "What happened?",
  expected: "What did you expect? (optional)",
  send: "Send report",
  sending: "Sending...",
  sendWithoutRecording: "Send without session",
  cancel: "Cancel",
  close: "Close",
  thanks: "Thanks, your report was received.",
  reference: "Reference",
  recordingOn: "Session recording is on.",
  recordingOff: "Session recording is off.",
  turnOff: "Turn off",
  turnOn: "Turn on",
} as const;

const ERRORS: Partial<Record<ReplayUploadErrorCode, string>> = {
  reporting_disabled: "Reporting is turned off right now. Your draft is kept.",
  rate_limited: "Too many reports in a short time. Wait a moment and send again.",
  invalid_evidence: "The session could not be attached.",
  identity_required: "Sign in to send a report.",
  not_configured: "Reporting is not set up for this app.",
  idempotency_conflict: "This report changed after an earlier attempt. Send it again to submit the new version.",
  invalid_request: "The report could not be sent. Check the text and try again.",
  cross_origin: "The report could not be sent from this page.",
};
const FALLBACK_ERROR = "We could not send your report. Your draft is kept; try again.";

interface FrozenContext {
  reportedAt: number;
  route: string;
  release: string | null;
  evidence: ReplayReportEvidence | null;
}

/**
 * The floating report button and its form. Everything that identifies the
 * moment - when the form opened, the page, the build and the session with its
 * millisecond offset, last trace id and last behavior marker - is frozen at
 * open, before the form renders, so navigating, a configuration refresh or a
 * session rotation cannot retarget it, and nothing the person types is part of
 * it. The queued telemetry is flushed before the report is sent, so the
 * session reaches Epic first. Submitting needs no session and works while
 * capture is off.
 *
 * The container is `data-private`, so a recording shows an empty box of the
 * same size instead of what the person types.
 */
export function ReplayReportButton({ release }: { release: string | null }) {
  const replay = useEpicReplay();
  const consent = useSyncExternalStore(epicReplayConsent.subscribe, epicReplayConsent.getSnapshot, () => "unknown" as const);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [expected, setExpected] = useState("");
  const [frozen, setFrozen] = useState<FrozenContext | null>(null);
  const [withoutEvidence, setWithoutEvidence] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const policy = useSyncExternalStore(replayLifecycle.subscribe, replayLifecycle.getSnapshot, () => serverPolicy);
  const { submit, isSending, acknowledgment, errorCode, reset } = useSubmitReplayReport();
  // One logical submission keeps one key until its content changes or it ends.
  const attempt = useRef<{ key: string; body: string } | null>(null);

  function freezeContext() {
    const reportedAt = Date.now();
    const reference = replay.getSessionReference();
    setFrozen({
      reportedAt,
      route: toReplayPathname(window.location.pathname) ?? "/",
      release,
      evidence: reference
        ? {
            sessionId: reference.sessionId,
            startedAt: reference.startedAt,
            offsetMs: Math.max(reportedAt - reference.startedAt, 0),
            ...(reference.traceId ? { traceId: reference.traceId } : {}),
            ...(reference.behaviorId ? { behaviorId: reference.behaviorId } : {}),
            ...(reference.occurrenceId ? { occurrenceId: reference.occurrenceId } : {}),
          }
        : null,
    });
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      freezeContext();
      return;
    }
    // Closing ends the logical submission; the next one gets a fresh key.
    if (acknowledgment) {
      setDescription("");
      setExpected("");
    }
    attempt.current = null;
    setWithoutEvidence(false);
    setFrozen(null);
    reset();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!frozen || isSending || flushing || !description.trim()) return;

    const request: Omit<ReplayReportRequest, "idempotencyKey"> = {
      contractVersion: 1,
      reportedAt: frozen.reportedAt,
      route: frozen.route,
      release: frozen.release,
      evidence: withoutEvidence ? null : frozen.evidence,
      description,
      ...(expected.trim() ? { expected } : {}),
    };
    // Resending identical content, or dropping rejected evidence, is the same
    // logical report; any other edit is a new one.
    const body = JSON.stringify({ ...request, evidence: undefined });
    const keep =
      attempt.current && (attempt.current.body === body || errorCode === "invalid_evidence");
    const key = keep ? attempt.current!.key : crypto.randomUUID();
    attempt.current = { key, body };

    // The session's telemetry goes first; a flush that gives up never blocks the report.
    setFlushing(true);
    try {
      if (request.evidence) await replay.flush();
    } finally {
      setFlushing(false);
    }
    submit({ ...request, idempotencyKey: key });
  }

  // After durable success, mark only the session the report refers to, with
  // nothing but the report reference. Emitted once per acknowledgment.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!acknowledgment || reported.current === acknowledgment.reportId) return;
    reported.current = acknowledgment.reportId;
    if (!frozen?.evidence || withoutEvidence) return;
    if (replay.getSessionReference()?.sessionId === frozen.evidence.sessionId) {
      replay.event("epic.bug.reported", { reportId: acknowledgment.reportId });
    }
  }, [acknowledgment, frozen, replay, withoutEvidence]);

  // Where consent is not required, an unanswered prompt means recording is on.
  const effectiveConsent =
    consent === "unknown" && policy.capture.consentMode === "not_required" ? "granted" : consent;
  const evidenceLine =
    frozen?.evidence && !withoutEvidence ? COPY.descriptionEvidence : COPY.descriptionAbsent;
  const errorMessage = errorCode ? (ERRORS[errorCode] ?? FALLBACK_ERROR) : null;

  return (
    <div data-private className="fixed right-4 bottom-4 z-40">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <MessageSquareWarningIcon aria-hidden />
          {COPY.trigger}
        </DialogTrigger>
        <DialogContent data-private>
          <DialogHeader>
            <DialogTitle>{COPY.title}</DialogTitle>
            <DialogDescription>{evidenceLine}</DialogDescription>
          </DialogHeader>

          {acknowledgment ? (
            <div className="grid gap-4" role="status">
              <p>{COPY.thanks}</p>
              <p className="text-muted-foreground text-xs">
                {COPY.reference}: {acknowledgment.reportId.slice(0, 8)}
              </p>
              <DialogFooter>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  {COPY.close}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form className="grid gap-4" onSubmit={onSubmit} noValidate>
              <div className="grid gap-2">
                <Label htmlFor="replay-report-description">{COPY.what}</Label>
                <Textarea
                  id="replay-report-description"
                  name="description"
                  required
                  maxLength={REPLAY_REPORT_TEXT_MAX}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  aria-invalid={errorMessage ? true : undefined}
                  aria-describedby={errorMessage ? "replay-report-error" : undefined}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="replay-report-expected">{COPY.expected}</Label>
                <Textarea
                  id="replay-report-expected"
                  name="expected"
                  maxLength={REPLAY_REPORT_TEXT_MAX}
                  value={expected}
                  onChange={(event) => setExpected(event.target.value)}
                />
              </div>

              {/* The one place a visitor who already chose can change their mind. */}
              {replay.status !== "disabled" && effectiveConsent !== "unknown" ? (
                <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
                  {effectiveConsent === "granted" ? COPY.recordingOn : COPY.recordingOff}
                  <button
                    type="button"
                    className="text-foreground underline underline-offset-2"
                    onClick={() => chooseReplayConsent(effectiveConsent === "granted" ? "withdrawn" : "granted")}
                  >
                    {effectiveConsent === "granted" ? COPY.turnOff : COPY.turnOn}
                  </button>
                </p>
              ) : null}

              {errorMessage ? (
                <p id="replay-report-error" role="alert" className="text-destructive text-sm">
                  {errorMessage}
                </p>
              ) : null}

              <DialogFooter>
                {errorCode === "invalid_evidence" && !withoutEvidence ? (
                  <Button type="button" variant="outline" onClick={() => setWithoutEvidence(true)}>
                    {COPY.sendWithoutRecording}
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {COPY.cancel}
                </Button>
                <Button type="submit" disabled={isSending || flushing || !description.trim()}>
                  {isSending || flushing ? COPY.sending : COPY.send}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
