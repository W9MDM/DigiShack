// The grid square out of an FT8/FT4 message, when it carries one.
//
// Only CQ and reply messages carry a locator ("CQ K1ABC FN42", "K1ABC W9XYZ EN61");
// reports and acknowledgements do not, and "RR73" LOOKS like a grid — RR73 is a real
// square in the Arctic Ocean that nobody is calling from, which is exactly why the
// protocol chose it as an acknowledgement. Extracted from the decodes page when the
// grid map became the second consumer.

export function gridFromMessage(message: string): string | null {
  const m = /\b([A-R]{2}\d{2})\b/.exec(message.toUpperCase());
  return m && m[1] !== "RR73" ? m[1]! : null;
}
