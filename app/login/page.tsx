import { isPasswordConfigured } from "@/lib/auth";
import { LoginForm } from "@/components/screens/LoginForm";

export const metadata = { title: "Sign in | The Furies Scheduler" };

export default function LoginPage() {
  const configured = isPasswordConfigured();

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex flex-col gap-1">
          <h1 className="font-display text-[34px] leading-[1.05] font-medium text-cross-navy">
            Cross Services Group
          </h1>
          <span className="type-eyebrow text-muted">The Furies Scheduler</span>
        </div>

        {configured ? (
          <LoginForm />
        ) : (
          <div className="rounded-[3px] border border-warn/40 bg-warn/8 p-5">
            <p className="text-[17px] text-ink">
              This app is not configured yet. Set <code className="type-mono">APP_PASSWORD</code> and{" "}
              <code className="type-mono">SESSION_SECRET</code> in{" "}
              <code className="type-mono">.env.local</code>, then restart the dev server.
            </p>
            <p className="mt-3 text-[15px] text-muted">
              The password gate is not optional: job notes contain door codes and lockbox
              combinations, so the app must not be reachable without it.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
