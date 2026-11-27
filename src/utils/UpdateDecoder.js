import * as buffer from 'lib0/buffer'
import * as decoding from 'lib0/decoding'
import * as error from 'lib0/error'
import * as number from 'lib0/number'

import { ID, createID } from './ID.js'

/**
 * @param {decoding.Decoder} decoder
 * @return {number}
 */
const readSafeVarUint = decoder => {
  const num = decoding.readVarUint(decoder)
  if (!(num >= 0 && num <= number.MAX_SAFE_INTEGER)) {
    throw error.unexpectedCase()
  }
  return num
}

/**
 * @param {decoding.UintOptRleDecoder} dec
 * @return {number}
 */
const readUintOptRle = dec => {
  if (dec.count === 0 && dec.pos >= dec.arr.length) {
    throw error.create('Unexpected end of array')
  }
  const val = dec.read()
  if (!(val >= 0 && val <= number.MAX_SAFE_INTEGER)) {
    throw error.unexpectedCase()
  }
  return val
}

/**
 * @param {decoding.IntDiffOptRleDecoder} dec
 * @return {number}
 */
const readIntDiffOptRle = dec => {
  if (dec.count === 0 && dec.pos >= dec.arr.length) {
    throw error.create('Unexpected end of array')
  }
  const val = dec.read()
  if (!(val >= 0 && val <= number.MAX_SAFE_INTEGER)) {
    throw error.unexpectedCase()
  }
  return val
}

/**
 * @param {decoding.RleDecoder<number>} dec
 * @return {number}
 */
const readRleUint8 = dec => {
  if (dec.count === 0 && dec.pos >= dec.arr.length) {
    throw error.create('Unexpected end of array')
  }
  return dec.read()
}

/**
 * Guarded replacement for `lib0/decoding.readAny` with EOF checks, tag validation,
 * container-length bounds checks, and nesting depth limits.
 *
 * @param {decoding.Decoder} decoder
 * @param {number} maxDepth
 * @param {number} depth
 * @return {any}
 */
const _readSafeAny = (decoder, maxDepth, depth) => {
  if (decoder.pos >= decoder.arr.length) {
    throw error.create('Unexpected end of array')
  }
  const tag = decoding.readUint8(decoder)
  switch (tag) {
    case 127:
      return undefined
    case 126:
      return null
    case 125:
      if (decoder.pos >= decoder.arr.length) {
        throw error.create('Unexpected end of array')
      }
      return decoding.readVarInt(decoder)
    case 124:
      return decoding.readFloat32(decoder)
    case 123:
      return decoding.readFloat64(decoder)
    case 122:
      return decoding.readBigInt64(decoder)
    case 121:
      return false
    case 120:
      return true
    case 119:
      return decoding.readVarString(decoder)
    case 118: {
      if (depth >= maxDepth) {
        throw error.unexpectedCase()
      }
      const len = decoding.readVarUint(decoder)
      if (len * 2 > decoder.arr.length - decoder.pos) {
        throw error.create('Unexpected end of array')
      }
      /**
       * @type {Object<string, any>}
       */
      const obj = {}
      const nextDepth = depth + 1
      for (let i = 0; i < len; i++) {
        const key = decoding.readVarString(decoder)
        const val = _readSafeAny(decoder, maxDepth, nextDepth)
        if (key === '__proto__') {
          Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true })
        } else {
          obj[key] = val
        }
      }
      return obj
    }
    case 117: {
      if (depth >= maxDepth) {
        throw error.unexpectedCase()
      }
      const len = decoding.readVarUint(decoder)
      if (len > decoder.arr.length - decoder.pos) {
        throw error.create('Unexpected end of array')
      }
      const arr = []
      const nextDepth = depth + 1
      for (let i = 0; i < len; i++) {
        arr.push(_readSafeAny(decoder, maxDepth, nextDepth))
      }
      return arr
    }
    case 116:
      return decoding.readVarUint8Array(decoder)
    default:
      throw error.unexpectedCase()
  }
}

/**
 * @param {decoding.Decoder} decoder
 * @param {number} [maxDepth]
 * @return {any}
 */
export const readSafeAny = (decoder, maxDepth = 128) => _readSafeAny(decoder, maxDepth, 0)

/**
 * @typedef {IdSetDecoderV1 | IdSetDecoderV2} IdSetDecoder
 */

export class IdSetDecoderV1 {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    this.restDecoder = decoder
  }

  resetDsCurVal () {
    // nop
  }

  /**
   * @return {number}
   */
  readDsClock () {
    return readSafeVarUint(this.restDecoder)
  }

  /**
   * @return {number}
   */
  readDsLen () {
    return readSafeVarUint(this.restDecoder)
  }
}

export class UpdateDecoderV1 extends IdSetDecoderV1 {
  /**
   * @return {ID}
   */
  readLeftID () {
    return createID(readSafeVarUint(this.restDecoder), readSafeVarUint(this.restDecoder))
  }

  /**
   * @return {ID}
   */
  readRightID () {
    return createID(readSafeVarUint(this.restDecoder), readSafeVarUint(this.restDecoder))
  }

  /**
   * Read the next client id.
   * Use this in favor of readID whenever possible to reduce the number of objects created.
   */
  readClient () {
    return readSafeVarUint(this.restDecoder)
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readInfo () {
    const info = decoding.readUint8(this.restDecoder)
    if (info === undefined) {
      throw error.create('Unexpected end of array')
    }
    return info
  }

  /**
   * @return {string}
   */
  readString () {
    return decoding.readVarString(this.restDecoder)
  }

  /**
   * @return {boolean} isKey
   */
  readParentInfo () {
    const info = decoding.readVarUint(this.restDecoder)
    if (info !== 0 && info !== 1) {
      throw error.unexpectedCase()
    }
    return info === 1
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readTypeRef () {
    return readSafeVarUint(this.restDecoder)
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @return {number} len
   */
  readLen () {
    return readSafeVarUint(this.restDecoder)
  }

  /**
   * @return {any}
   */
  readAny () {
    return readSafeAny(this.restDecoder)
  }

  /**
   * @return {Uint8Array}
   */
  readBuf () {
    return buffer.copyUint8Array(decoding.readVarUint8Array(this.restDecoder))
  }

  /**
   * Legacy implementation uses JSON parse. We use any-decoding in v2.
   *
   * @return {any}
   */
  readJSON () {
    return JSON.parse(decoding.readVarString(this.restDecoder))
  }

  /**
   * @return {string}
   */
  readKey () {
    return decoding.readVarString(this.restDecoder)
  }
}

export class IdSetDecoderV2 {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    /**
     * @private
     */
    this.dsCurrVal = 0
    this.restDecoder = decoder
  }

  resetDsCurVal () {
    this.dsCurrVal = 0
  }

  /**
   * @return {number}
   */
  readDsClock () {
    const diff = decoding.readVarUint(this.restDecoder)
    if (diff > number.MAX_SAFE_INTEGER - this.dsCurrVal) {
      throw error.unexpectedCase()
    }
    this.dsCurrVal += diff
    return this.dsCurrVal
  }

  /**
   * @return {number}
   */
  readDsLen () {
    const raw = decoding.readVarUint(this.restDecoder)
    if (raw >= number.MAX_SAFE_INTEGER - this.dsCurrVal) {
      throw error.unexpectedCase()
    }
    const diff = raw + 1
    this.dsCurrVal += diff
    return diff
  }
}

export class UpdateDecoderV2 extends IdSetDecoderV2 {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    super(decoder)
    /**
     * List of cached keys. If the keys[id] does not exist, we read a new key
     * from stringEncoder and push it to keys.
     *
     * @type {Array<string>}
     */
    this.keys = []
    decoding.readVarUint(decoder) // read feature flag - currently unused
    this.keyClockDecoder = new decoding.IntDiffOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.clientDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.leftClockDecoder = new decoding.IntDiffOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.rightClockDecoder = new decoding.IntDiffOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.infoDecoder = new decoding.RleDecoder(decoding.readVarUint8Array(decoder), decoding.readUint8)
    this.stringDecoder = new decoding.StringDecoder(decoding.readVarUint8Array(decoder))
    this.parentInfoDecoder = new decoding.RleDecoder(decoding.readVarUint8Array(decoder), decoding.readUint8)
    this.typeRefDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder))
    this.lenDecoder = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder))
  }

  /**
   * @return {ID}
   */
  readLeftID () {
    return new ID(readUintOptRle(this.clientDecoder), readIntDiffOptRle(this.leftClockDecoder))
  }

  /**
   * @return {ID}
   */
  readRightID () {
    return new ID(readUintOptRle(this.clientDecoder), readIntDiffOptRle(this.rightClockDecoder))
  }

  /**
   * Read the next client id.
   * Use this in favor of readID whenever possible to reduce the number of objects created.
   */
  readClient () {
    return readUintOptRle(this.clientDecoder)
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readInfo () {
    return readRleUint8(this.infoDecoder)
  }

  /**
   * @return {string}
   */
  readString () {
    const strDec = this.stringDecoder
    const len = readUintOptRle(strDec.decoder)
    const end = strDec.spos + len
    if (end > strDec.str.length) {
      throw error.create('Unexpected end of array')
    }
    const res = strDec.str.slice(strDec.spos, end)
    strDec.spos = end
    return res
  }

  /**
   * @return {boolean}
   */
  readParentInfo () {
    const info = readRleUint8(this.parentInfoDecoder)
    if (info !== 0 && info !== 1) {
      throw error.unexpectedCase()
    }
    return info === 1
  }

  /**
   * @return {number} An unsigned 8-bit integer
   */
  readTypeRef () {
    return readUintOptRle(this.typeRefDecoder)
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @return {number}
   */
  readLen () {
    return readUintOptRle(this.lenDecoder)
  }

  /**
   * @return {any}
   */
  readAny () {
    return readSafeAny(this.restDecoder)
  }

  /**
   * @return {Uint8Array}
   */
  readBuf () {
    return decoding.readVarUint8Array(this.restDecoder)
  }

  /**
   * This is mainly here for legacy purposes.
   *
   * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
   *
   * @return {any}
   */
  readJSON () {
    return readSafeAny(this.restDecoder)
  }

  /**
   * @return {string}
   */
  readKey () {
    const keyClock = readIntDiffOptRle(this.keyClockDecoder)
    if (keyClock < this.keys.length) {
      return this.keys[keyClock]
    } else if (keyClock === this.keys.length) {
      const key = this.readString()
      this.keys.push(key)
      return key
    } else {
      throw error.unexpectedCase()
    }
  }
}
