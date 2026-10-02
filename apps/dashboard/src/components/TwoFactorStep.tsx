import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { Mark } from "./icons";

/**
 * Sign-in, step 2 (prd/account-settings §3): after a correct password on an account with two-factor authentication,
 * the code from the authenticator app or a recovery code. Used by the sign-in page and the password reset page.
 */
export function TwoFactorStep({ challenge, onDone, onRestart, title = "Two-factor authentication", note }: {
  challenge: string; onDone: (r: { recovery_codes_left?: number }) => void; onRestart: (message: string) => void; title?: string; note?: string;
}) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // The field changes with the method: move the focus to it (the toggle button would keep it otherwise).
  useEffect(() => { input.current?.focus(); }, [recovery]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ recovery_codes_left?: number }>("/auth/login/2fa", { method: "POST", json: recovery ? { challenge, recovery_code: code.trim() } : { challenge, code: code.replace(/\s/g, "") } });
      onDone(r);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Something went wrong. Try again.";
      // The challenge is used up, expired or locked after too many tries: back to the password.
      if (err instanceof ApiError && (err.status === 400 || (err.status === 429 && /password again/.test(msg)))) { onRestart(msg); return; }
      setError(msg);
      setBusy(false);
    }
  };
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate aria-label={title}>
        <Mark size={36} />
        <div>
          <h1>{title}</h1>
          <p>{note ?? (recovery ? "Enter one of the recovery codes you saved when you turned on two-factor authentication. Each works once." : "Enter the 6-digit code from your authenticator app.")}</p>
        </div>
        {recovery ? (
          <div className="field"><label htmlFor="recovery-code">Recovery code</label><input ref={input} id="recovery-code" className="input mono" autoComplete="one-time-code" placeholder="abcde-fghjk" maxLength={20} value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} /></div>
        ) : (
          <div className="field"><label htmlFor="totp-code">Authentication code</label><input ref={input} id="totp-code" className="input mono code-input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={7} value={code} onChange={(e) => { setCode(e.target.value.replace(/[^\d ]/g, "")); setError(null); }} /></div>
        )}
        {error && <div className="banner err" role="alert">{error}</div>}
        <button className="btn btn-dark btn-lg" type="submit" disabled={busy || (recovery ? code.trim().length < 10 : code.replace(/\s/g, "").length !== 6)}>{busy ? "Checking…" : "Verify"}</button>
        <p><button type="button" className="link-u" onClick={() => { setRecovery(!recovery); setCode(""); setError(null); }}>{recovery ? "Use your authenticator app instead" : "Lost your phone? Use a recovery code"}</button></p>
      </form>
    </main>
  );
}
