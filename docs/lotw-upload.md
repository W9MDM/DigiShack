# LoTW upload, without TQSL

Researched from Cloudlog (`application/controllers/Lotw.php` and
`application/views/lotw_views/adif_views/adif_export.php`) because it demonstrably works and
this project's own attempt had stalled on the assumption that TQSL was required.

**It is not.** Cloudlog never invokes TQSL — grep the whole application and the only hits are
translation strings telling the user where to export their certificate FROM. Everything else
is done with OpenSSL primitives, which Node has natively in `node:crypto`.

## The certificate

The operator exports a `.p12` from TQSL (Callsign Certificates → export) and uploads it.
Cloudlog then:

1. `openssl_pkcs12_read(file, out, password)` — the p12 password, usually empty.
2. Re-exports the private key to PEM under a **known local passphrase**, and stores that PEM
   plus the certificate in the database.
3. `openssl_x509_parse(cert)` to read the metadata it needs:
   - `subject.undefined` → the issued **callsign** (LoTW puts it in an unnamed OID, which is
     why it lands under `undefined`)
   - `subject.commonName` → the operator's name
   - `validFrom_time_t` / `validTo_time_t` → the certificate's validity window
   - the DXCC entity id, used as `tSTATION.DXCC`

The validity window matters: LoTW rejects a signature over a QSO outside the certificate's
`qso_start_date`..`qso_end_date`, so contacts must be filtered by it before signing rather
than after being rejected.

## The upload file (`.tq8`)

A `.tq8` is **gzip of an ADIF-shaped record stream** — not XML, despite the extension
suggesting something structured. Records are ADIF `<TAG:length>value` fields terminated by
`<EOR>`, in three kinds:

    <TQSL_IDENT:...>TQSL V2.5.4 Lib: ... AllowDupes: false

    <Rec_Type:5>tCERT      + <CERT_UID:1>1 + <CERTIFICATE:n>  (base64 body, PEM
                             armour stripped)
    <Rec_Type:8>tSTATION   + <STATION_UID:1>1 <CERT_UID:1>1 <CALL> <DXCC>
                             and optionally GRIDSQUARE, ITUZ, CQZ, IOTA,
                             US_STATE / CA_PROVINCE, US_COUNTY
    <Rec_Type:8>tCONTACT   + <STATION_UID:1>1 <CALL> <BAND> <MODE> <FREQ>
                             <QSO_DATE> <TIME_ON> plus SIGN_LOTW_V2.0 and SIGNDATA

## The signature — the part that must be exact

Each `tCONTACT` carries two extra fields:

- `SIGNDATA` — the plaintext that was signed
- `SIGN_LOTW_V2.0` — base64 of `RSA-SHA1` over that plaintext, and the declared ADIF length
  counts the newline after the value, with a `:6` type indicator

**This section was WRONG in an earlier revision of this document, and the correction is the
most important thing on the page.** It had been written from memory of Cloudlog's source
rather than from the source, and it said the signed string began with the station callsign
and DXCC and used `YYYYMMDD` dates. It does none of that. A file built to the old
description would have been well-formed and silently refused, with no indication which part
was at fault and no test server to try it against.

The parts are concatenated with no separators, each upper-cased, each absent part omitted
entirely rather than left empty, **in alphabetical order of their ADIF field names** —
station fields first, then contact fields:

    CA_PROVINCE (Canada only), CQZ, GRIDSQUARE, IOTA, ITUZ, US_COUNTY, US_STATE,
    BAND, BAND_RX, CALL, FREQ, FREQ_RX, MODE, PROP_MODE,
    QSO_DATE, QSO_TIME, SAT_NAME

Points that are easy to get wrong and fail only at LoTW's end:

- **The station callsign and the station DXCC are NOT in the signature.** They appear in the
  tSTATION record only. Adding them is the single most likely way to break this.
- **The date carries dashes and the time carries colons**: `2026-08-23` and `14:30:05Z`, not
  `20260823` and `143005`. The `Z` is inside the signed string and inside the `QSO_TIME`
  field.
- **Frequency is MHz with trailing zeros trimmed**, derived from the stored Hz, and the same
  string goes into both the `FREQ` field and the signed bytes.
- The mode is LoTW's own mode name, mapped from ADIF mode + submode. FT8 and FT4 are
  distinct LoTW modes and sending `DATA` for either loses the mode.

Cloudlog reads its certificate extensions through PHP, which returns the raw `extnValue`
octets — ASN.1 header included — and stores them straight into MySQL columns that coerce
`"291"` to `291`. That works only for as long as the value never leaves a lenient
database. Ours strips the wrapper.

## Upload

`POST https://lotw.arrl.org/lotw/upload`, multipart, field name **`upfile`**, filename
ending `.tq8`. The response is text; Cloudlog looks for a success string in it. There is no
API key — the certificate IS the authentication, which is why the signature has to be right
rather than merely well-formed.

## What was built

`lotw.tqslPath` is gone. Nothing needs a TQSL binary, and requiring one made the feature
depend on a desktop GUI application that is not installed on a headless server and should
not be — which is why nothing had been uploaded since 1 August while the page reported the
sync as on.

- `lib/integrations/lotw-cert.ts` — reads the `.p12`, stores the key encrypted, reads the
  callsign, DXCC and QSO date window out of the certificate
- `lib/integrations/lotw-tq8.ts` — the mode map, the signed string, the record stream
- `lib/integrations/lotw-upload.ts` — the POST and, separately testable, the reply parser
- `scripts/check-lotw-upload.ts` — 76 assertions, including the golden signed strings

**What is measured and what is not.** Everything in the check script is measured: the `.p12`
round-trips through openssl, the certificate's own extensions are read back, every declared
ADIF length agrees with its contents, and the signature verifies against the certificate's
public key. That last one is INTERNAL CONSISTENCY only — it proves the signature is over the
bytes in `SIGNDATA`, not that LoTW agrees those are the right bytes. The golden strings are
transcribed from working software; only a real upload settles it.

Two things are reasoned and NOT measured:

- the `-legacy` retry when openssl refuses a TQSL-written PKCS#12. OpenSSL 3 moved 40-bit RC2
  into the legacy provider, so a stock `openssl pkcs12` fails on a file TQSL just produced.
  This could not be tested here because writing such a file needs the legacy provider too.
- the upload itself. Nothing has been POSTed to lotw.arrl.org from this code.

## What Node provides

    crypto.createSign("RSA-SHA1").update(signdata).sign(keyPem, "base64")
    new crypto.X509Certificate(pem)   // subject, validFrom, validTo, raw

`node:crypto` cannot read PKCS#12 — there is no KeyObject import for it — so that one step
shells out to openssl, with the file on stdin and the password in the environment rather
than argv. Everything else is native.
