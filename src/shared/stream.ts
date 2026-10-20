/**
 * The live Android video between the server and the window: WebSocket `/ws/stream`.
 * One socket is one stream; closing it stops the scrcpy server on the device.
 *
 * Text frames are JSON control messages (StreamToUi). Binary frames are H.264 packets as
 * scrcpy-server produced them (Annex B), behind a 9-byte header:
 *
 *     byte 0      flags: 1 = config packet (SPS/PPS), 2 = key frame
 *     bytes 1..8  presentation time in µs, big-endian u64 (0 for a config packet)
 *     bytes 9..   the packet
 *
 * Pure (no I/O), shared by both sides so the layout is written down once.
 */

export const STREAM_PATH = '/ws/stream'

/** Why a stream did not start or stopped. The window explains each one in its own words. */
export type StreamErrorCode =
  /** The server is in web mode. */
  | 'not_android'
  /** No scrcpy-server found: not configured, and no scrcpy on PATH. */
  | 'scrcpy_not_found'
  /** A scrcpy-server was found, but its version could not be told (it must match exactly). */
  | 'scrcpy_version_unknown'
  /** adb is not installed or not on PATH. */
  | 'device_no_adb'
  /** adb has no usable device: none attached, offline, unauthorized, or the LD_DEVICE serial is gone. */
  | 'device_not_found'
  /** Several devices and no LD_DEVICE: adb will not pick one. */
  | 'device_ambiguous'
  /** adb could not push or start it, or it exited (wrong version, encoder failure). */
  | 'scrcpy_failed'
  /** The device sent something this relay does not understand (another codec, a broken packet). */
  | 'stream_protocol'

export type StreamToUi =
  /** The server is pushing and starting scrcpy-server. */
  | { t: 'starting'; version: string }
  /**
   * A capture session began: frames from here on have this size (device pixels, maybe
   * downscaled). A new one follows a rotation or fold; the next packet is a config packet.
   */
  | { t: 'session'; width: number; height: number }
  /** The stream ended for good; `detail` is the cause as adb or scrcpy put it (English, may be empty). */
  | { t: 'error'; code: StreamErrorCode; detail: string }

export interface StreamPacket {
  config: boolean
  key: boolean
  /** Microseconds. */
  pts: number
  data: Uint8Array
}

export const PACKET_HEADER_BYTES = 9
const FLAG_CONFIG = 1
const FLAG_KEY = 2

export function encodePacket(p: StreamPacket): Uint8Array {
  const out = new Uint8Array(PACKET_HEADER_BYTES + p.data.length)
  const view = new DataView(out.buffer)
  out[0] = (p.config ? FLAG_CONFIG : 0) | (p.key ? FLAG_KEY : 0)
  view.setBigUint64(1, BigInt(Math.max(0, Math.floor(p.pts))))
  out.set(p.data, PACKET_HEADER_BYTES)
  return out
}

/** A binary frame → the packet, or null when it is too short to be one. */
export function decodePacket(frame: ArrayBuffer | Uint8Array): StreamPacket | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (bytes.length < PACKET_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const flags = bytes[0]!
  return {
    config: (flags & FLAG_CONFIG) !== 0,
    key: (flags & FLAG_KEY) !== 0,
    pts: Number(view.getBigUint64(1)),
    data: bytes.subarray(PACKET_HEADER_BYTES),
  }
}
