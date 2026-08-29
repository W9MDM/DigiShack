import net from "node:net";

import { adifRecord, type AdifQsoInput } from "@/lib/adif/write";

// N3FJP Amateur Contact Log, over its TCP API.
//
// Unlike every other target in this directory, this one is not a web service: it is a
// Windows program on the operator's own desk with a TCP listener, enabled under
// Settings -> Application Program Interface (API) -> "TCP API Enabled (Server)".
//
// PROTOCOL, from http://www.n3fjp.com/help/api.html (read, not guessed):
//
//   <CMD><ADDADIFRECORD><VALUE><CALL:6>KA3SEQ<QSO_Date:8>20220317<Time_On:6>205405
//   <Band:3>40M<Mode:3>SSB<EOR></VALUE></CMD>
//
// Three ways to log a contact are documented and this is the third:
//
//   * `<CMD><ACTION><VALUE>ENTER</VALUE></CMD>` logs whatever is in the program's entry
//     BOXES, so it requires filling them first and it fights the operator if they happen
//     to be typing. It is the only one with a documented acknowledgement.
//   * `<CMD><ADDDIRECT>…</CMD>` writes the database with `fld…` fields, which would mean
//     a second field mapping to keep in step with the ADIF writer.
//   * ADDADIFRECORD takes an ADIF record, which this project already produces, tests and
//     ships to four other services. One writer, one set of field decisions.
//
// THE PROTOCOL HAS NO ACKNOWLEDGEMENT FOR THIS COMMAND. The page documents a response
// for the ENTER action and says nothing whatever about a reply to ADDADIFRECORD. So
// "sent" here means the bytes were written and the connection stayed healthy — it does
// NOT mean Amateur Contact Log accepted the record. That distinction is why `detail`
// says so out loud rather than reporting a confident success.
//
// NOT VERIFIED AGAINST THE PROGRAM. Everything here follows the published specification;
// it has not yet been run against a live Amateur Contact Log.

/** The port N3FJP's API server listens on by default. */
export const N3FJP_DEFAULT_PORT = 1100;

export interface N3fjpResult {
  ok: boolean;
  /** Records written to the socket. */
  sent: number;
  /** Indexes of `qsos` that were written, so a partial run marks the right contacts. */
  doneIndexes: number[];
  detail: string;
  errors: string[];
}

/**
 * Send contacts to Amateur Contact Log.
 *
 * One connection for the whole batch rather than one per record: this is a program on a
 * desk, and reconnecting per contact would be both slower and more likely to be refused.
 */
export async function sendToN3fjp(
  qsos: AdifQsoInput[],
  opts: { host: string; port?: number; timeoutMs?: number },
): Promise<N3fjpResult> {
  const port = opts.port ?? N3FJP_DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const empty: N3fjpResult = { ok: true, sent: 0, doneIndexes: [], detail: "", errors: [] };

  if (!opts.host) {
    return { ...empty, ok: false, detail: "No N3FJP host configured" };
  }
  if (qsos.length === 0) return { ...empty, detail: "Nothing to send" };

  return await new Promise<N3fjpResult>((resolve) => {
    const doneIndexes: number[] = [];
    const errors: string[] = [];
    let replies = "";
    let settled = false;

    const socket = net.createConnection({ host: opts.host, port });
    socket.setEncoding("utf8");

    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, sent: doneIndexes.length, doneIndexes, detail, errors });
    };

    socket.setTimeout(timeoutMs, () => {
      finish(
        doneIndexes.length > 0,
        `N3FJP at ${opts.host}:${port} stopped responding after ${doneIndexes.length} record(s)`,
      );
    });

    socket.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      // A refused connection is the ordinary case, not a fault: the operator's logging
      // program is simply not running. Said plainly so the sweep's log does not read
      // like a broken integration every time the PC is off.
      const friendly = /ECONNREFUSED/.test(msg)
        ? `Nothing is listening on ${opts.host}:${port} — is Amateur Contact Log running with its TCP API server enabled?`
        : msg;
      finish(false, friendly);
    });

    // Anything the program says back. Not required, and not treated as a result — see
    // the header. Captured so a future reader has evidence rather than a guess.
    socket.on("data", (chunk) => {
      replies += String(chunk).slice(0, 2_000);
    });

    socket.on("connect", () => {
      for (let i = 0; i < qsos.length; i++) {
        // ONE LINE, terminated CR+LF, which is what the API requires of every command.
        // `adifRecord` ends its record with a newline for file output, and leaving that
        // in would split the command across two lines mid-payload.
        const adif = adifRecord(qsos[i]!).trim();
        socket.write(`<CMD><ADDADIFRECORD><VALUE>${adif}</VALUE></CMD>\r\n`);
        doneIndexes.push(i);
      }
      // A bare CR+LF is the documented way to say we are done, and the program closes
      // the connection on it.
      socket.write("\r\n");
      // Give it a moment to say something, then stop waiting. There is nothing to wait
      // FOR — no acknowledgement is specified — so this is a courtesy window, not a
      // handshake, and the timeout above is what bounds a truly dead peer.
      setTimeout(() => {
        finish(
          true,
          `${doneIndexes.length} record(s) sent to ${opts.host}:${port}` +
            // Reported every time, because a silent protocol cannot distinguish "logged"
            // from "the program threw it away", and pretending otherwise would put a
            // confirmation in the log that nothing checked.
            ` (the API returns no acknowledgement for ADDADIFRECORD, so this is what was
               sent, not what was accepted)`.replace(/\s+/g, " ") +
            (replies.trim() ? ` — it replied: ${replies.trim().slice(0, 200)}` : ""),
        );
      }, 400);
    });
  });
}
