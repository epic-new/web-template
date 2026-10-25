"use client";

import { useSignup } from "../behaviors/signup/use-signup.hook";
import { SIGNUP_URL } from "@/app.config";
import { useAppSignOut } from "@/shared/hooks/use-app-sign-out.hook";

// Simple Lock Icon for Password Field
const LockIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    className="w-5 h-5 text-muted-foreground"
  >
    <path
      fillRule="evenodd"
      d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
      clipRule="evenodd"
    />
  </svg>
);

// Simple User Icon for Email Field
const UserIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    className="w-5 h-5 text-muted-foreground"
  >
    <path
      fillRule="evenodd"
      d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
      clipRule="evenodd"
    />
  </svg>
);

interface SignUpFormProps {
  redirectURL: string;
}

export default function SignUpForm({ redirectURL }: SignUpFormProps) {
  const { state, formAction, isLoading } = useSignup(redirectURL);
  const { formAction: handleSignOut, isLoading: isPending, error: signOutError } = useAppSignOut(SIGNUP_URL);
  const isAlreadyLoggedInError = state.error?.includes("already logged in");
  const displayedError = signOutError ?? state.error;

  return (
    <form action={formAction} className="space-y-6">
      {displayedError && (
        <div
          className="border-2 border-dashed border-destructive/40 bg-destructive/10 px-4 py-3 relative"
          role="alert"
        >
          <span className="text-xs font-mono text-destructive/70 absolute -top-2 -left-2 bg-secondary px-1">
            ERROR
          </span>
          <div className="block font-mono text-destructive text-sm mt-2">
            <span>{displayedError}</span>
            {isAlreadyLoggedInError && (
              <button
                type="button"
                onClick={handleSignOut}
                disabled={isPending}
                className="ml-2 underline font-semibold hover:text-destructive/80 disabled:opacity-50 cursor-pointer"
              >
                {isPending ? "Signing out..." : "Sign out"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Email Field */}
      <div className="relative border border-dashed border-border bg-background p-1">
        <label htmlFor="email" className="sr-only">
          Email
        </label>
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
          <UserIcon />
        </div>
        <input
          type="email"
          id="email"
          name="email"
          required
          placeholder="you@example.com"
          className="block w-full pl-10 pr-3 py-2 bg-transparent border-none placeholder:text-muted-foreground text-foreground focus:outline-none text-sm"
        />
      </div>

      {/* Password Field */}
      <div className="relative border border-dashed border-border bg-background p-1">
        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
          <LockIcon />
        </div>
        <input
          type="password"
          id="password"
          name="password"
          required
          placeholder="Create a password (min. 8 characters)"
          className="block w-full pl-10 pr-3 py-2 bg-transparent border-none placeholder:text-muted-foreground text-foreground focus:outline-none text-sm"
        />
      </div>

      {/* Confirm Password Field */}
      <div className="relative border border-dashed border-border bg-background p-1">
        <label htmlFor="confirmPassword" className="sr-only">
          Confirm Password
        </label>
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
          <LockIcon />
        </div>
        <input
          type="password"
          id="confirmPassword"
          name="confirmPassword"
          required
          placeholder="Confirm your password"
          className="block w-full pl-10 pr-3 py-3 bg-transparent border-none placeholder:text-muted-foreground text-foreground focus:outline-none text-sm"
        />
      </div>

      <div className="relative">
        <button
          type="submit"
          disabled={isLoading}
          className="w-full flex justify-center items-center gap-2 py-3 px-4 rounded-lg bg-primary text-primary-foreground font-bold border-2 border-dashed border-primary hover:bg-primary/90 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <>
              <svg
                className="animate-spin -ml-1 mr-3 h-5 w-5 text-primary-foreground"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              CREATING ACCOUNT...
            </>
          ) : (
            <>
              CREATE ACCOUNT
              <span className="text-primary-foreground/70">→</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
