import { isDeployed, isPasswordConfigured, missingAuthSettings } from "@/lib/auth";
import { LoginForm } from "@/components/screens/LoginForm";

export const metadata = { title: "Sign in | The Furies Scheduler" };

// Env vars are read per request, so this screen must never be cached — a
// deployment that fixes the settings would otherwise keep showing the old page.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const configured = isPasswordConfigured();
  const missing = missingAuthSettings();
  const deployed = isDeployed();

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
              {missing.length === 1
                ? "This app is missing one setting:"
                : "This app is missing some settings:"}
            </p>

            <ul className="mt-2 flex flex-col gap-1">
              {missing.map((name) => (
                <li key={name} className="type-mono text-ink">
                  {name}
                </li>
              ))}
            </ul>

            {/* Telling someone to edit .env.local is useless on a deployed app. */}
            {deployed ? (
              <p className="mt-4 text-[15px] text-ink">
                Add {missing.length === 1 ? "it" : "them"} in Vercel under{" "}
                <span className="font-medium">Project Settings → Environment Variables</span>, then
                redeploy. Environment variables are only picked up by a new deployment, so saving
                alone will not fix this.
              </p>
            ) : (
              <p className="mt-4 text-[15px] text-ink">
                Add {missing.length === 1 ? "it" : "them"} to{" "}
                <code className="type-mono">.env.local</code>, then restart the dev server —
                Next.js only reads that file at startup.
              </p>
            )}

            <p className="mt-3 text-[15px] text-muted">
              <code className="type-mono">SESSION_SECRET</code> signs the login cookie and can be
              any random string over 16 characters. It does not need to match your local one.
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
