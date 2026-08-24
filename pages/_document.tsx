import { Head, Html, Main, NextScript } from "next/document";

// `color-scheme: dark` is set on <html> as an attribute rather than only in CSS
// so form controls and scrollbars render dark on the very first paint, before
// the stylesheet applies.
export default function AppDocument() {
  return (
    <Html lang="en" style={{ colorScheme: "dark" }}>
      <Head>
        {/*
         * PWA head tags live here rather than in _app because they belong to the
         * document, not to a page, and because the manifest link has to be present on
         * the very first response — an install prompt is offered on page load, and a
         * manifest that arrives with a client-side hydration is a manifest the browser
         * has already decided about.
         *
         * Kept out of _app's <Head> for one more reason: the bare routes (/login,
         * /setup) render without the Shell, and an install offered from a login screen
         * should still install the app rather than a bookmark to the login screen.
         */}
        <link rel="manifest" href="/manifest.webmanifest" />

        {/* iOS ignores the manifest icon list entirely and reads this. */}
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="icon" href="/icons/favicon-32.png" sizes="32x32" />
        <link rel="icon" href="/icons/favicon-16.png" sizes="16x16" />
        <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />

        {/*
         * `apple-mobile-web-app-capable` is the deprecated spelling and
         * `mobile-web-app-capable` is the current one. Both are here on purpose: Safari
         * still honours only the former, and dropping it is how an iOS install quietly
         * goes back to opening in a browser tab with the address bar showing.
         */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="DigiShack" />
        {/* `black-translucent` puts the page under the status bar, which is why the
            Shell pads by env(safe-area-inset-top). */}
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="application-name" content="DigiShack" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
