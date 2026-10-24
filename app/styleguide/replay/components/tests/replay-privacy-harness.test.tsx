// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { resetPreviewReplayCapture } from "../../behaviors/preview-replay-capture/use-preview-replay-capture.hook";
import { ReplayPrivacyHarness } from "../ReplayPrivacyHarness";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function bufferJson() {
  return (screen.getByLabelText("Buffered events") as HTMLTextAreaElement).value;
}

function type(label: string, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

describe("ReplayPrivacyHarness", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/styleguide/replay");
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    resetPreviewReplayCapture();
    epicReplayConsent.reset();
    replayLifecycle.reset();
    vi.restoreAllMocks();
  });

  it("captures nothing under the application policy, even after consent", async () => {
    render(<ReplayPrivacyHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Grant consent" }));
    type("Private field (inside data-private)", "synthetic-secret-4111");
    await flush();

    expect(screen.getByLabelText("Capture status")).toHaveTextContent("Blocked: policy_disabled");
    expect(screen.getByText(/Buffered events:/)).toHaveTextContent("Buffered events: 0");
    expect(bufferJson()).toBe("[]");
  });

  it("stores only masked and redacted content, and clears it on withdrawal", async () => {
    render(<ReplayPrivacyHarness />);

    fireEvent.click(screen.getByLabelText("Synthetic policy, sampled"));
    expect(screen.getByLabelText("Capture status")).toHaveTextContent("Blocked: consent_absent");

    fireEvent.click(screen.getByRole("button", { name: "Grant consent" }));
    type("Private field (inside data-private)", "synthetic-secret-4111");
    type("Password", "hunter2-synthetic");
    type("Email", "synthetic@example.test");
    await flush();

    expect(screen.getByLabelText("Capture status")).toHaveTextContent("Capturing");
    const stored = bufferJson();
    for (const secret of [
      "synthetic-secret-4111",
      "hunter2-synthetic",
      "synthetic@example.test",
      "Synthetic SSN 000-12-3456",
      "synthetic-access-token",
      "synthetic-proxy-token",
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).toContain("access_token=%5Bredacted%5D");

    fireEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));

    expect(screen.getByLabelText("Capture status")).toHaveTextContent("Blocked: consent_withdrawn");
    expect(bufferJson()).toBe("[]");
    expect(screen.getByText("Capture stopped. Local recording data on this device was cleared.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/deleted/i);
  });

  it("shows not sampled for the unsampled policy", () => {
    render(<ReplayPrivacyHarness />);

    fireEvent.click(screen.getByLabelText("Synthetic policy, not sampled"));
    fireEvent.click(screen.getByRole("button", { name: "Grant consent" }));

    expect(screen.getByLabelText("Capture status")).toHaveTextContent("Blocked: not_sampled");
    expect(bufferJson()).toBe("[]");
  });
});
