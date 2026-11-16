"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, putJson, postJson } from "@/lib/api";
import { useDialog } from "@/components/Dialog";
import type { EmailAccount, SmtpConfigStatus } from "@/lib/types";

function isValidEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

export default function EmailSettingsPage() {
  const { toast, prompt } = useDialog();

  const [status, setStatus] = useState<SmtpConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<EmailAccount | null>(null);

  const [active, setActive] = useState<EmailAccount | null>(null);

  // Gmail / SMTP slot
  const [gSender, setGSender] = useState("");
  const [gFromName, setGFromName] = useState("");
  const [gPassword, setGPassword] = useState("");
  const [gHost, setGHost] = useState("");
  const [gPort, setGPort] = useState("");
  const [gUseTls, setGUseTls] = useState(true);
  const [gAdvanced, setGAdvanced] = useState(false);

  // Outlook / Microsoft 365 slot
  const [oSender, setOSender] = useState("");
  const [oFromName, setOFromName] = useState("");
  const [oTenant, setOTenant] = useState("");
  const [oClient, setOClient] = useState("");
  const [oSecret, setOSecret] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    getJson<SmtpConfigStatus>("/settings/smtp")
      .then((s) => {
        setStatus(s);
        setActive(s.active);
        setGSender(s.gmail.sender_email ?? "");
        setGFromName(s.gmail.from_name ?? "");
        setGHost(s.gmail.host ?? "");
        setGPort(s.gmail.port != null ? String(s.gmail.port) : "");
        setGUseTls(s.gmail.use_tls);
        if (s.gmail.host || s.gmail.port) setGAdvanced(true);
        setOSender(s.outlook.sender_email ?? "");
        setOFromName(s.outlook.from_name ?? "");
        setOTenant(s.outlook.tenant_id ?? "");
        setOClient(s.outlook.client_id ?? "");
      })
      .catch(() => toast({ variant: "error", message: "Could not load the email settings." }))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  // --- validation -------------------------------------------------------------------------
  const gHasSender = gSender.trim() !== "";
  const oHasSender = oSender.trim() !== "";
  const gSenderValid = !gHasSender || isValidEmail(gSender);
  const oSenderValid = !oHasSender || isValidEmail(oSender);
  const gPortNum = gPort.trim() === "" ? null : Number(gPort);
  const gPortValid = gPortNum === null || (Number.isInteger(gPortNum) && gPortNum >= 1 && gPortNum <= 65535);
  const gNeedsPassword = gHasSender && !status?.gmail.has_password && !gPassword.trim();
  const oNeedsSecret = oHasSender && !status?.outlook.has_client_secret && !oSecret.trim();
  const oFieldsOk = !oHasSender || (oTenant.trim() !== "" && oClient.trim() !== "");
  const anyConfigured = gHasSender || oHasSender;
  const canSave =
    anyConfigured &&
    gSenderValid &&
    oSenderValid &&
    gPortValid &&
    !gNeedsPassword &&
    !oNeedsSecret &&
    oFieldsOk &&
    !saving;

  async function handleSave() {
    setSaving(true);
    try {
      const saved = await putJson<SmtpConfigStatus>("/settings/smtp", {
        active,
        gmail: {
          sender_email: gSender.trim(),
          from_name: gFromName.trim() || null,
          password: gPassword,
          host: gHost.trim() || null,
          port: gPort.trim() ? Number(gPort) : null,
          use_tls: gUseTls,
        },
        outlook: {
          sender_email: oSender.trim(),
          from_name: oFromName.trim() || null,
          tenant_id: oTenant.trim() || null,
          client_id: oClient.trim() || null,
          client_secret: oSecret,
        },
      });
      setStatus(saved);
      setActive(saved.active);
      setGPassword("");
      setOSecret("");
      toast({ variant: "success", message: "Email settings saved." });
    } catch (err) {
      toast({
        variant: "error",
        message: err instanceof Error && err.message ? err.message : "Could not save the settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(account: EmailAccount) {
    const sender = account === "gmail" ? status?.gmail.sender_email : status?.outlook.sender_email;
    const recipient = await prompt({
      title: "Send a test email to",
      description:
        "Pick an address you can check (your personal inbox is a good test). If it doesn't arrive, also check Spam/Junk and the sender's Sent folder.",
      defaultValue: sender ?? "",
      placeholder: "recipient@example.com",
      confirmLabel: "Send test",
    });
    if (recipient == null) return; // cancelled
    if (!isValidEmail(recipient)) {
      toast({ variant: "error", message: "Enter a valid email address." });
      return;
    }
    setTesting(account);
    try {
      const res = await postJson<{ recipient: string }>("/settings/smtp/test", {
        account,
        recipient_email: recipient.trim(),
      });
      toast({
        variant: "success",
        message: `Accepted by the server — sent to ${res.recipient}. If it's not in the inbox, check Spam/Junk and the Sent folder.`,
      });
    } catch (err) {
      toast({
        variant: "error",
        message: err instanceof Error && err.message ? err.message : "Connection failed — could not send the test email.",
      });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto w-full px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Email settings</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Configure one or both sender accounts for consolidated interview reports, and pick which
          one is active. Gmail uses an app password; Outlook / Microsoft 365 uses Microsoft Graph.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Active sender */}
          <div className="rounded-md border border-zinc-200 bg-surface p-4 space-y-2">
            <h2 className="text-sm font-semibold text-zinc-800">Active sender</h2>
            <p className="text-xs text-zinc-500">Reports are emailed from the selected account.</p>
            <div className="flex gap-4 pt-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="active"
                  checked={active === "gmail"}
                  disabled={!gHasSender}
                  onChange={() => setActive("gmail")}
                />
                Gmail{status?.gmail.sender_email ? ` (${status.gmail.sender_email})` : ""}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="active"
                  checked={active === "outlook"}
                  disabled={!oHasSender}
                  onChange={() => setActive("outlook")}
                />
                Outlook{status?.outlook.sender_email ? ` (${status.outlook.sender_email})` : ""}
              </label>
            </div>
          </div>

          {/* Gmail / SMTP account */}
          <div className="space-y-3 rounded-md border border-zinc-200 bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-800">Gmail / SMTP account</h2>
              {status?.gmail.configured && (
                <button
                  type="button"
                  onClick={() => handleTest("gmail")}
                  disabled={testing !== null}
                  className="btn-outline text-xs px-2 py-1 disabled:opacity-50"
                >
                  {testing === "gmail" ? "Testing…" : "Test connection"}
                </button>
              )}
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-zinc-700">Sender email address</span>
              <input
                type="email"
                value={gSender}
                onChange={(e) => setGSender(e.target.value)}
                placeholder="hiring@gmail.com"
                className="input w-full"
              />
              {!gSenderValid && <span className="text-[11px] text-red-600">Enter a valid email address.</span>}
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-zinc-700">
                App password{" "}
                {status?.gmail.has_password && <span className="text-zinc-400">(leave blank to keep current)</span>}
              </span>
              <input
                type="password"
                value={gPassword}
                onChange={(e) => setGPassword(e.target.value)}
                placeholder={status?.gmail.has_password ? "••••••••  (unchanged)" : "App password"}
                autoComplete="new-password"
                className="input w-full"
              />
              {gNeedsPassword && <span className="text-[11px] text-red-600">An app password is required.</span>}
              <span className="text-[11px] text-zinc-500">
                Gmail requires an <strong>app password</strong> (2-factor enabled), not your normal password.
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-zinc-700">From name (optional)</span>
              <input
                value={gFromName}
                onChange={(e) => setGFromName(e.target.value)}
                placeholder="Tychons Recruitment Team"
                className="input w-full"
              />
            </label>

            <button type="button" onClick={() => setGAdvanced((v) => !v)} className="text-xs text-blue-700 hover:underline">
              {gAdvanced ? "Hide" : "Show"} advanced (manual SMTP host/port)
            </button>
            {gAdvanced && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <label className="block space-y-1 flex-1">
                    <span className="text-xs font-medium text-zinc-700">SMTP host</span>
                    <input value={gHost} onChange={(e) => setGHost(e.target.value)} placeholder="smtp.gmail.com" className="input w-full" />
                  </label>
                  <label className="block space-y-1 w-28">
                    <span className="text-xs font-medium text-zinc-700">Port</span>
                    <input type="number" value={gPort} onChange={(e) => setGPort(e.target.value)} placeholder="587" className="input w-full" />
                  </label>
                </div>
                {!gPortValid && <span className="text-[11px] text-red-600">Port must be 1–65535.</span>}
                <label className="flex items-center gap-2 text-xs text-zinc-700">
                  <input type="checkbox" checked={gUseTls} onChange={(e) => setGUseTls(e.target.checked)} />
                  Use STARTTLS (recommended for port 587)
                </label>
                <p className="text-[11px] text-zinc-500">Leave blank for Gmail — auto-detected.</p>
              </div>
            )}
          </div>

          {/* Outlook / Microsoft 365 account */}
          <div className="space-y-3 rounded-md border border-zinc-200 bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-800">Outlook / Microsoft 365 account</h2>
              {status?.outlook.configured && (
                <button
                  type="button"
                  onClick={() => handleTest("outlook")}
                  disabled={testing !== null}
                  className="btn-outline text-xs px-2 py-1 disabled:opacity-50"
                >
                  {testing === "outlook" ? "Testing…" : "Test connection"}
                </button>
              )}
            </div>
            <p className="text-[11px] text-zinc-500">
              Needs an Azure AD app with the <strong>Mail.Send application</strong> permission (admin consent).
              No account password — Microsoft blocks password SMTP.
            </p>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-zinc-700">Sender email address</span>
              <input
                type="email"
                value={oSender}
                onChange={(e) => setOSender(e.target.value)}
                placeholder="hiring@yourcompany.com"
                className="input w-full"
              />
              {!oSenderValid && <span className="text-[11px] text-red-600">Enter a valid email address.</span>}
            </label>

            <div className="flex gap-2">
              <label className="block space-y-1 flex-1">
                <span className="text-xs font-medium text-zinc-700">Tenant ID</span>
                <input value={oTenant} onChange={(e) => setOTenant(e.target.value)} placeholder="Directory (tenant) ID" className="input w-full" />
              </label>
              <label className="block space-y-1 flex-1">
                <span className="text-xs font-medium text-zinc-700">Client ID</span>
                <input value={oClient} onChange={(e) => setOClient(e.target.value)} placeholder="Application (client) ID" className="input w-full" />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-zinc-700">
                Client secret{" "}
                {status?.outlook.has_client_secret && <span className="text-zinc-400">(leave blank to keep current)</span>}
              </span>
              <input
                type="password"
                value={oSecret}
                onChange={(e) => setOSecret(e.target.value)}
                placeholder={status?.outlook.has_client_secret ? "••••••••  (unchanged)" : "Client secret value"}
                autoComplete="new-password"
                className="input w-full"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-zinc-700">From name (optional)</span>
              <input value={oFromName} onChange={(e) => setOFromName(e.target.value)} placeholder="Tychons Recruitment Team" className="input w-full" />
            </label>

            {!oFieldsOk && <span className="text-[11px] text-red-600">Tenant ID and Client ID are required.</span>}
            {oNeedsSecret && <span className="text-[11px] text-red-600">A client secret is required.</span>}
          </div>

          <div>
            <button onClick={handleSave} disabled={!canSave} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">
              {saving ? "Saving…" : "Save settings"}
            </button>
            <p className="text-[11px] text-zinc-500 mt-1">
              Test connection appears on each account once it&apos;s saved.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
