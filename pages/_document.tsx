import { Head, Html, Main, NextScript } from "next/document";

// `color-scheme: dark` is set on <html> as an attribute rather than only in CSS
// so form controls and scrollbars render dark on the very first paint, before
// the stylesheet applies.
export default function AppDocument() {
  return (
    <Html lang="en" style={{ colorScheme: "dark" }}>
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
