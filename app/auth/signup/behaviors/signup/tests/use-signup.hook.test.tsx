// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getUser: vi.fn() };
});

import { db } from "@/db";
import * as schema from "@/db/schema";
import { getUser } from "@/lib/auth";
import { PostDB, PreDB } from "@/lib/db-test";
import { createTestClient, queryWrapper } from "@/shared/tests/test-utils";
import { useSignup } from "../use-signup.hook";

describe("signup hook scenarios", () => {
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [] });
    vi.mocked(getUser).mockResolvedValue({ user: null } as never);
  });

  it("submits valid signup data through the real action", async () => {
    const email = "hook-user@example.com";
    const form = new FormData();
    form.set("email", email);
    form.set("password", "securePassword123");
    form.set("confirmPassword", "securePassword123");
    const { result } = renderHook(() => useSignup("/"), {
      wrapper: queryWrapper(createTestClient()),
    });

    act(() => result.current.formAction(form));

    // The mutation starts after this call returns, so wait for its outcome,
    // not for a loading flag that is already false before it begins.
    await waitFor(async () => {
      await PostDB(db, schema, {
        user: [{ email, emailVerified: false }],
        account: [{ providerId: "credential" }],
      });
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.state.error).toBeNull();
  });
});
