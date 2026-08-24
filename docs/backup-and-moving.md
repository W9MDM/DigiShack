# Backup and moving an installation

**Backup** in the nav, ADMIN only.

## What a backup contains

A **bundle** — a gzipped tar holding:

- `database.sql` — every table: the log, settings including their encrypted secrets,
  users, stations, DXCC reference data, the QSL queue, park references.
- `files/data/…` — everything on disk that is yours. In practice the QSL card artwork,
  which is deliberately not in git and is usually the largest thing here.
- `manifest.json` — version, schema migration, row counts, a SHA-256 of the dump, and
  what the database server does about identifier case.
- `RESTORE.md` — how to unpack it by hand if this application is not available.

`Database only (.sql.gz)` still produces a bare dump for feeding straight to `mysql`.

**Sessions are excluded deliberately.** Restoring them would hand every browser that
was logged in on the old machine a valid session on the new one, turning a migration
into an access-control problem. Everyone signs in again; that is the correct outcome.

## The settings key

The one thing a database dump cannot carry.

Service credentials — QRZ, LoTW, eQSL, Club Log, SMTP — are stored **encrypted**, and
the key is `SETTINGS_KEY` in `.env`. Move the database without it and every one of them
restores as unreadable ciphertext. Nothing errors; things just quietly stop working, and
you find out days later.

The checkbox will put the key in the bundle. Off by default, and that is a real choice
rather than ceremony: the dump already holds every credential encrypted, so a bundle
**with** the key is a single file that can act as your station on every service it
touches. Treat it like a password — not in email, not in a shared folder, not in git.

Even when included, it is never written to `.env` automatically. Editing the file the
application reads its own database credentials from, from a web request, is not
something this should do on its own. The restore tells you; you copy one line.

## Restoring

Upload the file. Which shape it is comes from the content, not the filename, so a
renamed download still works.

It **replaces the entire database** — every QSO, setting and user currently there. Two
confirmations, the second typed. There is no undo, and the QSOs that vanish are
precisely the ones nobody exported.

The database goes first. If it fails, the files are untouched and you still have a
coherent installation to try again from.

**Restart the application and the radio service afterwards.** Prisma holds a connection
pool and settings are cached in memory; serving from that state once the tables
underneath have been replaced fails in ways that look like corruption.

## The Linux trap

The single thing most likely to break a real migration, and it is silent.

MySQL and MariaDB **on Windows** default to `lower_case_table_names=1` and fold every
table name, so the database holds `qso` and `qsosigref` where Prisma's schema says `Qso`
and `QsoSigRef`. Locally this is invisible, because the server is then case-insensitive
about it too.

Restore that dump **onto Linux**, where the default is `0` and names are
case-*sensitive*, and it creates lower-case tables that Prisma cannot find. The
application starts, connects to the database, and fails every single query with "table
doesn't exist".

The manifest records this — measured from the actual table names, not inferred from the
platform — and a restore compares and warns. Two ways out:

1. Set `lower_case_table_names=1` in the new server's config and restart it **before**
   creating the database. It cannot be changed afterwards.
2. Or run `npm run db:deploy` against an empty database to create the tables with their
   proper names, then load only the `INSERT` statements from `database.sql`.

## Moving an installation, start to finish

1. On the old machine: **Back up everything**, with the settings key if you accept what
   that means. Download it.
2. On the new machine: install as in [Getting started](getting-started.md), including
   creating an empty database.
3. Copy `SETTINGS_KEY=` from the old `.env` into the new one, unless it is in the
   bundle.
4. Sign in, go to **Backup**, upload.
5. Read the warnings. Restart both processes.
6. Check: a QSO with a park reference shows its parks; a QSL preview renders with your
   artwork; Settings shows your service credentials as configured rather than empty.

`DATABASE_URL` is not in the bundle — it is machine-specific, and the new installation
should point at its own database.

## The updater takes one

Applying an update runs `prisma migrate deploy`, which alters tables and cannot be
undone. So the update takes a full bundle first, and **refuses to migrate if it
cannot** — an update that cannot back up is an update that must not touch the
schema. If the backup fails the run stops with the database untouched.

## Where backups live

`backups/`, which is excluded from git because a dump holds every credential and the
whole log.

**Copy them somewhere off the machine.** A backup that only exists on the computer it
came from is not a backup.

## Verifying

```bash
npm run check:restore
```

Builds a bundle, creates a scratch database, applies the dump, and compares row counts,
an encrypted setting byte-for-byte, and the artwork byte-for-byte. It uses a separate
database and never touches the live one.

A backup that has never been restored is a hypothesis. This is the difference.
