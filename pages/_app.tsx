import "@/styles/globals.css";

import type { AppProps } from "next/app";
import { Oswald } from "next/font/google";
import Head from "next/head";
import { useRouter } from "next/router";

import { Shell } from "@/components/layout/Shell";
import { SessionProvider, type SessionUser } from "@/lib/client/session";
import type { UiFlags } from "@/lib/auth/guard";

// Self-hosted at build time by next/font — no runtime request to Google, which
// matters for a LAN-only shack install with no outbound internet.
const oswald = Oswald({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-oswald",
});

/** Rendered without the app chrome — there's nothing to navigate to yet. */
const BARE_ROUTES = new Set(["/login", "/setup", "/forgot", "/reset-password"]);

export default function App({ Component, pageProps }: AppProps) {
  const { pathname } = useRouter();
  const bare = BARE_ROUTES.has(pathname);

  // withPageAuth injects `user` into every guarded page's props.
  const user = (pageProps as { user?: SessionUser }).user ?? null;
  // Injected by withPageAuth alongside `user`, so the navigation is correct on the first
  // paint rather than flickering after a client fetch.
  const uiFlags = (pageProps as { uiFlags?: UiFlags }).uiFlags;

  return (
    <div className={oswald.variable}>
      <Head>
        <title>DigiShack</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0a0a0b" />
      </Head>
      <SessionProvider user={user}>
        {bare ? (
          <main className="min-h-screen bg-bg text-fg flex items-center justify-center p-4">
            <Component {...pageProps} />
          </main>
        ) : (
          <Shell uiFlags={uiFlags}>
            <Component {...pageProps} />
          </Shell>
        )}
      </SessionProvider>
    </div>
  );
}
