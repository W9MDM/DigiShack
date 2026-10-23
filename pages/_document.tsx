import Document, { Head, Html, Main, NextScript, type DocumentContext, type DocumentInitialProps } from "next/document";

import { THEME_INIT_SCRIPT } from "@/components/ui/ThemeToggle";
import { NONCE_HEADER } from "@/lib/security/csp";

type Props = DocumentInitialProps & { nonce?: string };

// `color-scheme: dark` is set on <html> as an attribute rather than only in CSS
// so form controls and scrollbars render dark on the very first paint, before
// the stylesheet applies. Both themes are dark, so it holds for night too.
export default class AppDocument extends Document<Props> {
  /**
   * The CSP nonce proxy.ts minted for this request. Every inline script on the page has to
   * carry it (see lib/security/csp.ts): Next's own Turbopack bootstrap, which <Head> and
   * <NextScript> stamp when given the nonce, and the theme script below. A page rendered
   * without the proxy (the prebuilt /404) gets none, and simply renders without its script.
   */
  static async getInitialProps(ctx: DocumentContext): Promise<Props> {
    const initial = await Document.getInitialProps(ctx);
    const raw = ctx.req?.headers[NONCE_HEADER];
    const nonce = typeof raw === "string" && raw ? raw : undefined;
    return { ...initial, nonce };
  }

  render() {
    const { nonce } = this.props;
    return (
      <Html lang="en" style={{ colorScheme: "dark" }}>
        <Head nonce={nonce}>
          {/*
           * The saved theme, applied before anything paints. It is a blocking inline script
           * on purpose and it is tiny: deferred to React it would run after hydration, and a
           * night-mode operator would get a frame of the full-brightness palette on every
           * page load — the one thing night mode exists to prevent. <html> is rendered only
           * by this document and never hydrated, so setting an attribute on it here cannot
           * cause a hydration mismatch. It needs the nonce like any inline script.
           */}
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
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
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
