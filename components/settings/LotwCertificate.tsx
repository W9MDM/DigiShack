import { useEffect, useRef, useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";

// Uploading the LoTW callsign certificate.
//
// This is what makes LoTW uploads possible at all. `lotw.tqslPath` used to sit in this
// group, pointing at a TQSL binary — a desktop GUI application that is not installed on a
// headless server and should not be — so the upload path could never run, which is why
// nothing had reached LoTW since August 1st while the page reported the sync as on.
//
// A .p12 IS SOMEBODY'S LICENCE IDENTITY. The private key inside signs contacts as that
// callsign. So the file is never written to disk on the way through, the extracted key is
// stored encrypted under SETTINGS_KEY, and nothing here ever reads it back — the panel shows
// only what the certificate SAYS about itself. The wording below tells the operator that,
// because "upload your private key" deserves an answer to "and then what".

interface CertInfo {
  callsign: string;
  name: string | null;
  dxcc: number | null;
  validFrom: string;
  validTo: string;
  qsoStart: string | null;
  qsoEnd: string | null;
  uploadedAt: string;
  expired: boolean;
  daysLeft: number;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function LotwCertificate() {
  const [cert, setCert] = useState<CertInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/integrations/lotw-cert");
      const body = (await res.json().catch(() => null)) as { certificate?: CertInfo | null } | null;
      setCert(body?.certificate ?? null);
    } catch {
      // A failed read is not worth an error banner: the upload form below still works, and
      // the panel simply shows nothing on file.
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      // The password travels in a HEADER, not the query string: query strings reach access
      // logs and referrers, and this one opens a private key.
      const res = await fetch("/api/integrations/lotw-cert", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-pkcs12",
          "X-P12-Password": password,
        },
        body: file,
      });
      const body = (await res.json().catch(() => null)) as
        | { certificate?: CertInfo; error?: string }
        | null;
      if (!res.ok) {
        setProblem(body?.error ?? `Upload failed (${res.status})`);
        return;
      }
      setCert(body?.certificate ?? null);
      setNote(`Stored the certificate for ${body?.certificate?.callsign ?? "your callsign"}.`);
      // Cleared on success only. A wrong password should leave it in the box to be
      // corrected rather than retyped from scratch.
      setPassword("");
    } catch {
      setProblem("Could not upload that file");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    if (!confirm("Remove the stored LoTW certificate? Uploads to LoTW will stop until another is uploaded.")) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/integrations/lotw-cert", { method: "DELETE" });
      if (!res.ok) {
        setProblem(`Could not remove it (${res.status})`);
        return;
      }
      setCert(null);
      setNote("Removed. The stored private key is gone from this server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1 border-t border-line/60">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">Callsign certificate</span>
        <HelpTip label="About the LoTW certificate">
          Uploads to LoTW are authenticated by a signature on every contact, not by a
          password — so the username and password above only download confirmations, and
          nothing can be uploaded until a certificate is here. Export it from TQSL: Callsign
          Certificates, right-click yours, Export, and keep the private key in the file.
          <br />
          <br />
          The file itself is never written to this server&apos;s disk. The private key inside
          is stored encrypted with your <code>SETTINGS_KEY</code>, and nothing reads it back
          except the uploader when it signs a batch.
        </HelpTip>
      </div>

      {loaded && cert ? (
        <div className="rounded border border-line/60 bg-bg-subtle/40 p-3 text-sm flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-semibold">{cert.callsign}</span>
            {cert.name ? <span className="text-fg-subtle">{cert.name}</span> : null}
            {cert.dxcc !== null ? (
              <span className="text-fg-subtle text-xs">DXCC {cert.dxcc}</span>
            ) : null}
          </div>
          <div className="text-xs text-fg-subtle">
            Valid {day(cert.validFrom)} to {day(cert.validTo)}
            {cert.qsoStart || cert.qsoEnd ? (
              <>
                {" · covers contacts from "}
                {day(cert.qsoStart)} to {day(cert.qsoEnd)}
              </>
            ) : null}
          </div>
          {cert.expired ? (
            <div className="text-xs text-danger">
              This certificate has expired. LoTW refuses anything signed with it — renew it in
              TQSL and upload the new one.
            </div>
          ) : cert.daysLeft <= 45 ? (
            // Warned early rather than at the point of failure: a renewal needs a request to
            // ARRL and a wait, and the first sign otherwise is a rejected batch.
            <div className="text-xs text-warn">
              Expires in {cert.daysLeft} day{cert.daysLeft === 1 ? "" : "s"}. Renew it in TQSL
              before then, or uploads will start being refused.
            </div>
          ) : null}
          <div>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="mt-1 text-xs text-danger hover:underline disabled:opacity-50"
            >
              Remove this certificate
            </button>
          </div>
        </div>
      ) : loaded ? (
        <p className="text-sm text-fg-subtle">
          No certificate on file, so nothing can be uploaded to LoTW yet.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-col gap-1 text-xs text-fg-subtle">
          <span>Certificate password</span>
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="usually blank"
            className="rounded border border-line bg-bg px-2 py-1 text-sm text-fg w-48"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-subtle">
          <span>{cert ? "Replace certificate (.p12)" : "Certificate file (.p12)"}</span>
          <input
            ref={fileRef}
            type="file"
            accept=".p12,.pfx,application/x-pkcs12"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
            className="text-sm text-fg file:mr-2 file:rounded file:border file:border-line file:bg-bg-subtle file:px-2 file:py-1 file:text-xs file:text-fg"
          />
        </label>
      </div>

      {busy ? <p className="text-xs text-fg-subtle">Reading the certificate…</p> : null}
      {problem ? <p className="text-xs text-danger">{problem}</p> : null}
      {note ? <p className="text-xs text-ok">{note}</p> : null}

      <p className="text-xs text-fg-subtle">
        A <code>.tq6</code> is a certificate <em>request</em> and cannot sign anything — the
        file needed here is the <code>.p12</code> that TQSL exports once ARRL has issued the
        certificate.
      </p>
    </div>
  );
}
