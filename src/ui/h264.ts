/**
 * The H.264 bits WebCodecs needs from scrcpy's stream. scrcpy sends Annex B (start codes):
 * one config packet with SPS and PPS per capture session, then frames. `VideoDecoder`
 * takes Annex B as is when `configure()` gets no `description`; it then reads SPS/PPS
 * in-band, so the config packet goes in front of every key frame (what scrcpy's own client
 * does). That avoids building an avcC record, whose layout differs per profile. Pure.
 */

const NAL_SPS = 7

/** NAL units of an Annex B buffer (3- or 4-byte start codes), without their start codes. */
export function nalUnits(data: Uint8Array): Uint8Array[] {
  const starts: Array<{ at: number; len: number }> = []
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push({ at: i, len: 3 })
        i += 2
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        starts.push({ at: i, len: 4 })
        i += 3
      }
    }
  }
  return starts.map((s, k) => data.subarray(s.at + s.len, k + 1 < starts.length ? starts[k + 1]!.at : data.length))
}

export function nalType(unit: Uint8Array): number {
  return unit.length ? unit[0]! & 0x1f : -1
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * `avc1.PPCCLL` for `VideoDecoder.configure` from the SPS in a config packet: profile_idc,
 * the constraint flags byte and level_idc, the three bytes after the NAL header. Null when
 * the packet has no SPS.
 */
export function avcCodecString(config: Uint8Array): string | null {
  const sps = nalUnits(config).find((u) => nalType(u) === NAL_SPS)
  if (!sps || sps.length < 4) return null
  return `avc1.${hex2(sps[1]!)}${hex2(sps[2]!)}${hex2(sps[3]!)}`
}

/** A key frame as the decoder gets it: the session's SPS/PPS first, then the frame. */
export function withConfig(config: Uint8Array, frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(config.length + frame.length)
  out.set(config, 0)
  out.set(frame, config.length)
  return out
}
