import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePacket, encodePacket, PACKET_HEADER_BYTES } from './stream.ts'

test('a packet survives the trip to the window: flags, pts and bytes', () => {
  const data = Uint8Array.from([0, 0, 0, 1, 0x65, 0xb8])
  for (const p of [
    { config: true, key: false, pts: 0, data },
    { config: false, key: true, pts: 1_000_000, data },
    { config: false, key: false, pts: 2 ** 40 + 7, data },
  ]) {
    const frame = encodePacket(p)
    assert.equal(frame.length, PACKET_HEADER_BYTES + data.length)
    const back = decodePacket(frame.slice().buffer)
    assert.deepEqual({ ...back!, data: [...back!.data] }, { ...p, data: [...data] })
  }
})

test('a frame shorter than the header is not a packet', () => {
  assert.equal(decodePacket(new Uint8Array(PACKET_HEADER_BYTES - 1)), null)
  assert.deepEqual(decodePacket(new Uint8Array(PACKET_HEADER_BYTES))?.data.length, 0)
})

test('reads a packet that sits inside a larger buffer (a subarray)', () => {
  const frame = encodePacket({ config: false, key: true, pts: 42, data: Uint8Array.from([9, 8]) })
  const padded = new Uint8Array(frame.length + 4)
  padded.set(frame, 4)
  const p = decodePacket(padded.subarray(4))
  assert.equal(p?.pts, 42)
  assert.deepEqual([...p!.data], [9, 8])
})
