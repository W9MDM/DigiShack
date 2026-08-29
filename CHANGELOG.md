# Changelog

## 1.127.0 - public release

Development happens in a private repository; this is where the public history starts.
Earlier entries are not reproduced - they quote real operators by callsign, include
captured on-air exchanges, and reference one station's hardware and network. The
engineering reasoning they recorded lives in the code comments, which is where it is
useful anyway.

Notes for anyone running this:

- **There is no default callsign, anywhere.** First-run setup asks for the station
  callsign and grid, the transmit path refuses to start without them, and common
  placeholders are rejected by name.
- **Automatic transmit is off by default**, behind an explicit setting, with duty-cycle,
  wall-clock, SWR and PA-temperature limits.
- **The Rig page is experimental** and hidden until `ui.experimental.rig` is enabled.
  Its panadapter dB scale is not calibrated; readings are relative.
- **Some behaviour is measured against hardware and some is read from documentation.**
  Where they differ the code says which it is.
