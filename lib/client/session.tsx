import { createContext, useContext, type ReactNode } from "react";

import type { Role } from "@/lib/types";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  callsign: string | null;
  role: Role;
}

// Populated from getServerSideProps via withPageAuth, so it's available on first
// render — no loading flash and no client fetch just to learn who you are.
const SessionContext = createContext<SessionUser | null>(null);

export function SessionProvider({
  user,
  children,
}: {
  user: SessionUser | null;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={user}>{children}</SessionContext.Provider>
  );
}

/** Null on the public pages (/login, /setup). */
export function useUser(): SessionUser | null {
  return useContext(SessionContext);
}

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

/**
 * Role check for the UI. This only hides controls — it is not a security
 * boundary. Every mutation is independently enforced server-side by authedRoute,
 * so a VIEWER who un-hides a button still gets a 403.
 */
export function useCan(required: Role): boolean {
  const user = useUser();
  if (!user) return false;
  return RANK[user.role] >= RANK[required];
}
