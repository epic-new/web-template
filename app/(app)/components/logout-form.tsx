"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppSignOut } from "@/shared/hooks/use-app-sign-out.hook";

export function LogoutForm() {
  const { formAction, isLoading, error } = useAppSignOut();
  return (
    <form action={formAction} aria-label="Sign out">
      <Button type="submit" variant="ghost" size="sm" disabled={isLoading}
        className="text-muted-foreground hover:text-foreground">
        <LogOut className="mr-2 h-4 w-4" />
        {isLoading ? "Signing out..." : "Logout"}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
