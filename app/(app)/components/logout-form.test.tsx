// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ formAction: vi.fn(), isLoading: false, error: null as string | null }));
vi.mock("@/shared/hooks/use-app-sign-out.hook", () => ({ useAppSignOut: () => state }));

import { LogoutForm } from "./logout-form";

afterEach(() => {
  state.formAction.mockClear();
  state.isLoading = false;
  state.error = null;
});

describe("LogoutForm", () => {
  it("submits through the identity-aware behavior", () => {
    render(<LogoutForm />);
    fireEvent.submit(screen.getByRole("form", { name: "Sign out" }));
    expect(state.formAction).toHaveBeenCalledOnce();
  });

  it("shows pending and failure state without turning redirect into an error", () => {
    state.isLoading = true;
    const { rerender } = render(<LogoutForm />);
    expect(screen.getByRole("button", { name: "Signing out..." })).toBeDisabled();
    state.isLoading = false;
    state.error = "Authentication unavailable";
    rerender(<LogoutForm />);
    expect(screen.getByRole("button", { name: "Logout" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Authentication unavailable");
  });
});
