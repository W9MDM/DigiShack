// The password policy, in a module the BROWSER can load.
//
// This constant used to live in `lib/auth/password.ts` next to the hashing code, which
// reads well and broke the users page: that module opens with
//
//     import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
//
// and `pages/users.tsx` imported the constant from it to label a form field. Next then
// bundled the whole module — `node:crypto` and all — into the client, where the import
// cannot resolve and the module throws as it evaluates. The page never rendered:
//
//     Application error: a client-side exception has occurred
//
// with nothing in the server logs, because nothing had gone wrong on the server.
//
// `pages/setup.tsx` imports the same constant and was FINE, which is what made this
// confusing. It uses the value only inside `getServerSideProps`, and Next strips that
// function and its exclusive imports out of the client bundle — so the identical-looking
// import was harmless there and fatal here. That difference is invisible in the source.
//
// Hence a separate file with NO server-only imports, and none may be added: anything a
// page needs at render time has to be reachable without pulling in node builtins.

// Length beats composition rules — a 12-character passphrase is stronger than "P@ss1!"
// and easier to remember, so there are no character-class requirements.
export const MIN_PASSWORD_LENGTH = 12;
