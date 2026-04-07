import { readSession } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await readSession();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md border border-[var(--line)] bg-[var(--panel)]/88 p-8 backdrop-blur">
        <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--muted)]">Admin access</div>
        <h1 className="mt-3 text-[32px] font-semibold tracking-[-0.03em]">Grid Bot Control</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          Single-operator terminal for live and paper Solana spot grid bots.
        </p>

        <form action="/api/auth/login" method="post" className="mt-8 space-y-4">
          <label className="block">
            <span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Username</span>
            <input
              name="username"
              className="w-full border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3 text-sm text-white outline-none transition focus:border-[var(--line-strong)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Password</span>
            <input
              type="password"
              name="password"
              className="w-full border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3 text-sm text-white outline-none transition focus:border-[var(--line-strong)]"
            />
          </label>
          <button className="w-full border border-[var(--line-strong)] bg-white px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-[#091018] transition hover:opacity-90">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
