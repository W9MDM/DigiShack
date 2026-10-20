// Telnet bytes in, text lines out.
//
// Cluster nodes are telnet servers, and some of them negotiate: AR-Cluster and a few DX
// Spider front ends open with IAC DO/WILL sequences (terminal type, echo, suppress-go-ahead).
// Left in the stream those are 0xFF bytes in the first line, which is the login prompt — so
// a client that does not strip them can fail to see the prompt it is waiting for.
//
// The negotiation answer is the RFC 854 minimum: refuse everything (DO -> WONT, WILL -> DONT),
// and answer each option once per connection, so a server that repeats itself cannot start
// a loop. Subnegotiation is discarded whole.
//
// Line framing accepts CR, LF, CRLF and LFCR alike — nodes differ, and some send LFCR — by
// treating any of them as an end of line and dropping the empty lines the pairs produce.
// Nothing a cluster sends is meaningful as an empty line.

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

type State = "data" | "iac" | "opt" | "sb" | "sb-iac";

export class TelnetLineDecoder {
  private state: State = "data";
  private cmd = 0;
  private line: number[] = [];
  private answered = new Set<number>();

  /** A line longer than this is emitted as it stands: a cluster line is ~80 characters. */
  constructor(private readonly maxLine = 2048) {}

  /** Forget everything, for a new connection. */
  reset(): void {
    this.state = "data";
    this.cmd = 0;
    this.line = [];
    this.answered.clear();
  }

  /**
   * The unterminated text so far. A login prompt ("login: ") is never followed by a
   * newline, so this is where it is found.
   */
  get partial(): string {
    return Buffer.from(this.line).toString("utf8");
  }

  /** Drop the unterminated text — once a prompt has been answered it must not reappear as a line. */
  discardPartial(): void {
    this.line = [];
  }

  push(chunk: Uint8Array): { lines: string[]; reply: Buffer | null } {
    const lines: string[] = [];
    const reply: number[] = [];

    const endLine = () => {
      if (this.line.length > 0) {
        // Decoded per LINE, not per chunk, so a UTF-8 character split across two TCP reads
        // is reassembled before it is decoded.
        lines.push(Buffer.from(this.line).toString("utf8"));
        this.line = [];
      }
    };

    for (const b of chunk) {
      switch (this.state) {
        case "data":
          if (b === IAC) this.state = "iac";
          else if (b === 13 || b === 10) endLine();
          else if (b !== 0) {
            this.line.push(b);
            if (this.line.length >= this.maxLine) endLine();
          }
          break;
        case "iac":
          if (b === IAC) {
            // An escaped 0xFF is data.
            this.line.push(b);
            this.state = "data";
          } else if (b === WILL || b === WONT || b === DO || b === DONT) {
            this.cmd = b;
            this.state = "opt";
          } else if (b === SB) {
            this.state = "sb";
          } else {
            // NOP, GA, DM, AYT and friends: nothing to do for a line reader.
            this.state = "data";
          }
          break;
        case "opt": {
          const key = (this.cmd << 8) | b;
          if (!this.answered.has(key) && (this.cmd === DO || this.cmd === WILL)) {
            this.answered.add(key);
            reply.push(IAC, this.cmd === DO ? WONT : DONT, b);
          }
          this.state = "data";
          break;
        }
        case "sb":
          if (b === IAC) this.state = "sb-iac";
          break;
        case "sb-iac":
          this.state = b === SE ? "data" : "sb";
          break;
      }
    }

    return { lines, reply: reply.length > 0 ? Buffer.from(reply) : null };
  }
}
