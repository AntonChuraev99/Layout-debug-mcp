---
title: "Android live video: scrcpy-server relayed to WebCodecs, tree still polled"
date: 2026-10-20
type: decision
keywords: [android, scrcpy, webcodecs, h264, websocket, stream, overlay]
---

# Android live video: scrcpy-server relayed to WebCodecs, tree still polled

## Context

The Android frame was a screenshot refreshed every 800 ms (source: `INTERVAL_MS` in `src/ui/useAndroidAutoRefresh.ts`) and paused during a drag (#21). Animations and scrolling were not visible, and most of each capture's time was the on-device PNG encode.

## Decision

- **Source.** Push the user's own `scrcpy-server` (from the scrcpy install on `PATH`, or `LD_SCRCPY_SERVER`) and start it with `app_process`: video only, H.264, `tunnel_forward=true`, `send_device_meta=false`, `max_size=1920`, `adb forward tcp:0` to `localabstract:scrcpy_<scid>` (source: scrcpy 4.1 `doc/develop.md` "Protocol", `Streamer.java`, `DesktopConnection.java`). Nothing is bundled; the version argument comes from `scrcpy --version` or `LD_SCRCPY_VERSION`, because the server refuses any other.
- **Relay.** One `/ws/stream` socket per window, one server run per socket, behind the same Host/Origin checks as `/ws` (`checkStreamUpgrade`). Node parses the scrcpy stream (`src/server/scrcpy.ts`) and sends each packet with a 9-byte header (`src/shared/stream.ts`). Closing the socket closes the scrcpy socket, which makes the server exit; the forward is removed.
- **Decode.** `VideoDecoder` gets Annex B with no `description`; the config packet (SPS/PPS) is put in front of every key frame and gives the `avc1.PPCCLL` codec string (`src/ui/h264.ts`).
- **Overlay.** Boxes keep coming from `/tree`. The video covers the whole display and the tree's boxes are display pixels, so a video with the viewport's aspect (within `STREAM_ASPECT_TOLERANCE`, `src/ui/geometry.ts`) is stretched onto the viewport rect; `pxPerUnit` does not change (`streamPlacement`). Another shape (rotation, split screen) is drawn whole and centred and reported in the status pill.

## Why

- An avcC `description` needs per-profile extension fields (High profile, which the tested Pixel encoder uses); in-band SPS/PPS avoids building it.
- One run per socket instead of a shared stream: a late window would otherwise wait for the next key frame (seconds apart, approximately) or need a cache of the whole GOP.
- Polling stays for the tree: it carries the boxes and source anchors the video cannot. While every window shows video, captures skip the screenshot (`androidCapture.picture: false`).

## Consequences

- The scrcpy protocol is internal and changes between versions; the parser follows 4.x and reports anything else as `stream_protocol`.
- Two windows streaming at once start two encoders on the device.
- A slow window drops frames until the next key frame, so it can freeze for up to that interval.
