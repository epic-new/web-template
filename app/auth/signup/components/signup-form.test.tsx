// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const formAction = vi.fn();
const signOutFormAction = vi.fn();
let signupError: string | null = null;
vi.mock("../behaviors/signup/use-signup.hook", () => ({
  useSignup: () => ({
    state: { error: signupError },
    formAction,
    isLoading: false,
  }),
}));
vi.mock("@/shared/hooks/use-app-sign-out.hook", () => ({
  useAppSignOut: () => ({ formAction: signOutFormAction, isLoading: false, error: null }),
}));

import SignUpForm from "./signup-form";

afterEach(() => {
  signupError = null;
  vi.clearAllMocks();
});

describe("signup form scenarios", () => {
  it("switches an already signed-in account through the identity-aware sign-out behavior", () => {
    signupError = "You are already logged in";
    render(<SignUpForm redirectURL="/" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOutFormAction).toHaveBeenCalledOnce();
    expect(formAction).not.toHaveBeenCalled();
  });

  it("submits the entered account data to the behavior", () => {
    render(<SignUpForm redirectURL="/" />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "securePassword123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "securePassword123" },
    });

    fireEvent.submit(
      screen.getByRole("button", { name: /CREATE ACCOUNT/ }).closest("form")!,
    );

    expect(formAction).toHaveBeenCalledOnce();
    const submitted = formAction.mock.calls[0][0] as FormData;
    expect(submitted.get("email")).toBe("user@example.com");
    expect(submitted.get("password")).toBe("securePassword123");
    expect(submitted.get("confirmPassword")).toBe("securePassword123");
  });
});
