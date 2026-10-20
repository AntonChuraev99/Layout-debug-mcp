import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avcCodecString, nalType, nalUnits, withConfig } from './h264.ts'

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
// The config packet a Pixel 9 sent through scrcpy 4.1 (SPS, PPS), shortened: High profile, level 4.2.
const CONFIG = hex('000000016764002aacb406c0' + '0000000168ee3cb0')

test('splits Annex B on 4- and 3-byte start codes', () => {
  const units = nalUnits(hex('00000001' + '6764002a' + '000001' + '68ee' + '00000001' + '65b84f'))
  assert.deepEqual(units.map((u) => Buffer.from(u).toString('hex')), ['6764002a', '68ee', '65b84f'])
  assert.deepEqual(units.map(nalType), [7, 8, 5])
  assert.deepEqual(nalUnits(hex('6764')), [])
})

test('codec string from the SPS: avc1.PPCCLL', () => {
  assert.equal(avcCodecString(CONFIG), 'avc1.64002a')
  // Baseline 3.1 with constraint_set0/1 (a common encoder default).
  assert.equal(avcCodecString(hex('0000000167428c1f')), 'avc1.428c1f')
})

test('no SPS in the packet: no codec string', () => {
  assert.equal(avcCodecString(hex('0000000168ee3cb0')), null)
  assert.equal(avcCodecString(hex('0000000167')), null)
})

test('a key frame goes to the decoder with the session SPS/PPS in front', () => {
  const frame = hex('0000000165b84f')
  const merged = withConfig(CONFIG, frame)
  assert.deepEqual(nalUnits(merged).map(nalType), [7, 8, 5])
  assert.equal(merged.length, CONFIG.length + frame.length)
})
