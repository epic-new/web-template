import { getUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SIGNIN_URL } from "@/app.config";
import { ImpersonationBanner } from "@/app/admin/components/impersonation-banner";
import { LogoutForm } from "./components/logout-form";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isImpersonating } = await getUser();

  if (!user) redirect(SIGNIN_URL);

  return (
    <div className="min-h-screen bg-linear-to-b from-zinc-50 to-white dark:from-zinc-950 dark:to-black">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="container mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-end">
            <LogoutForm />
          </div>
        </div>
      </header>

      {isImpersonating && (
        <ImpersonationBanner impersonatedUserName={user.name || user.email} />
      )}
      <div className="container mx-auto px-4 py-4 sm:px-6 lg:px-8">
        {children}
      </div>
    </div>
  );
}
