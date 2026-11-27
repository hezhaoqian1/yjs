/**
 * @module encoding
 */
/*
 * We use the first five bits in the info flag for determining the type of the struct.
 *
 * 0: GC
 * 1: Item with Deleted content
 * 2: Item with JSON content
 * 3: Item with Binary content
 * 4: Item with String content
 * 5: Item with Embed content (for richtext content)
 * 6: Item with Format content (a formatting marker for richtext content)
 * 7: Item with Type
 */

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as error from 'lib0/error'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as number from 'lib0/number'
import * as array from 'lib0/array'

import { getStateVector, StructStore } from './StructStore.js'
import { findIndexSS, getItemCleanStart, getItemCleanEnd } from './transaction-helpers.js'
import { applyDeleteSet, createIdSet, IdRange, readAndApplyDeleteSet, readIdSet, mergeIdSets, writeIdSet } from './ids.js'
import { createID, ID } from './ID.js'
import { UpdateDecoderV1, UpdateDecoderV2, IdSetDecoderV1 } from './UpdateDecoder.js'
import { UpdateEncoderV1, UpdateEncoderV2, IdSetEncoderV1, IdSetEncoderV2 } from './UpdateEncoder.js'
import { convertUpdateFormatV2ToV1, LazyStructReader, LazyStructWriter, writeStructToLazyStructWriter, finishLazyStructWriting } from './updates.js'
import { readBlockSet, writeBlockSet } from './BlockSet.js'
import { Skip } from '../structs/Skip.js'
import { Item } from '../structs/Item.js'
import { GC } from '../structs/GC.js'
import { Doc } from './Doc.js'
import { writeStructs } from './encoding-helpers.js'

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {StructStore} store
 * @param {Map<number,number>} _sm
 *
 * @private
 * @function
 */
export const writeClientsStructs = (encoder, store, _sm) => {
  // we filter all valid _sm entries into sm
  const sm = new Map()
  _sm.forEach((clock, client) => {
    // only write if new structs are available
    if (store.getClock(client) > clock) {
      sm.set(client, clock)
    }
  })
  getStateVector(store).forEach((_clock, client) => {
    if (!_sm.has(client)) {
      sm.set(client, 0)
    }
  })
  // write # states that were updated
  encoding.writeVarUint(encoder.restEncoder, sm.size)
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  array.from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client))
    const lastStruct = structs[structs.length - 1]
    writeStructs(encoder, structs, client, [new IdRange(clock, lastStruct.id.clock + lastStruct.length - clock)])
  })
}

/**
 * Integrate structs from `clientsStructRefs` in topological (causal dependency) order.
 *
 * Uses an iterative DFS over intra-update dependencies (looking up any missing dependency ID
 * directly inside `clientsStructRefs` via `findIndexSS`). Structs whose causal dependencies
 * are missing externally, covered by a `Skip`, cyclic, or transitively blocked on a deferred
 * struct are individually deferred into `restStructs`, allowing independent structs (even from
 * the same client at later clocks) to integrate cleanly.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {BlockSet} clientsStructRefs
 * @param {Set<number> | null} [integratedClients=null]
 * @return { null | { update: Uint8Array<ArrayBuffer>, missing: Map<number,number> } }
 *
 * @private
 * @function
 */
const integrateStructs = (transaction, store, clientsStructRefs, integratedClients = null) => {
  // sort them so that we take the higher id first, in case of conflicts the lower id will probably not conflict with the id from the higher user.
  const clientsStructRefsIds = array.from(clientsStructRefs.clients.keys()).sort((a, b) => a - b)
  if (clientsStructRefsIds.length === 0) {
    return null
  }
  const getNextStructTarget = () => {
    while (clientsStructRefsIds.length > 0) {
      const nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item|Skip>}} */ (clientsStructRefs.clients.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]))
      if (nextStructsTarget.i < nextStructsTarget.refs.length) {
        return nextStructsTarget
      }
      clientsStructRefsIds.pop()
    }
    return null
  }
  let curStructsTarget = getNextStructTarget()
  if (curStructsTarget === null) {
    return null
  }

  /**
   * @type {Array<Item | GC>}
   */
  const stack = []
  /**
   * Lazy-allocated sets — stay `null` on the common in-order fast path.
   * @type {Set<Item | GC> | null}
   */
  let inStack = null
  /**
   * @type {Set<Item | GC> | null}
   */
  let integratedOutOfOrder = null
  /**
   * @type {Set<Item | GC> | null}
   */
  let deferred = null
  /**
   * @type {Map<number, number> | null}
   */
  let missingSV = null
  /**
   * Look up a non-Skip struct covering `id` inside `clientsStructRefs`.
   *
   * @param {ID} id
   * @return {Item | GC | null}
   */
  const findStructInUpdate = id => {
    const depTarget = clientsStructRefs.clients.get(id.client)
    if (depTarget === undefined) {
      return null
    }
    const depRefs = depTarget.refs
    const len = depRefs.length
    if (len === 0) {
      return null
    }
    const clock = id.clock
    const last = depRefs[len - 1]
    if (clock < depRefs[0].id.clock || clock >= last.id.clock + last.length) {
      return null
    }
    const dep = depRefs[findIndexSS(depRefs, clock)]
    if (dep.constructor === Skip) {
      return null
    }
    return /** @type {Item | GC} */ (dep)
  }

  // caching the state (high-water clock per client) because it is used very often
  const state = new Map()

  /**
   * Advance main loop to the next unprocessed non-Skip struct, or return `null` if done.
   *
   * @return {Item | GC | null}
   */
  const nextMainStruct = () => {
    while (curStructsTarget !== null) {
      while (curStructsTarget.i < curStructsTarget.refs.length) {
        const candidate = curStructsTarget.refs[curStructsTarget.i++]
        if (candidate.constructor === Skip) {
          continue
        }
        const s = /** @type {Item | GC} */ (candidate)
        if ((integratedOutOfOrder !== null && integratedOutOfOrder.has(s)) || (deferred !== null && deferred.has(s))) {
          continue
        }
        return s
      }
      curStructsTarget = getNextStructTarget()
    }
    return null
  }

  /**
   * @type {Item | GC | null}
   */
  let stackHead = nextMainStruct()
  // iterate over all struct readers until we are done
  while (stackHead !== null) {
    const missing = getMissing(/** @type {any} */ (stackHead), transaction, store)
    if (missing !== null) {
      const dep = findStructInUpdate(missing)
      if (
        dep === null ||
        dep === stackHead ||
        (missing.client === stackHead.id.client && missing.clock >= stackHead.id.clock) ||
        (inStack !== null && inStack.has(dep)) ||
        (deferred !== null && deferred.has(dep))
      ) {
        // Externally missing, covered by a Skip, cyclic, or blocked on an already-deferred dep.
        // Record `missing.clock` even for deferred/cyclic deps so a later GC override wakes retry.
        if (missingSV === null) {
          missingSV = new Map()
        }
        const mclock = missingSV.get(missing.client)
        if (mclock == null || mclock > missing.clock) {
          missingSV.set(missing.client, missing.clock)
        }
        if (deferred === null) {
          deferred = new Set()
        }
        deferred.add(stackHead)
      } else {
        // Resolve intra-update dependency first, then re-evaluate `stackHead` (which may have
        // additional missing dependencies: origin, rightOrigin, parent).
        if (inStack === null) {
          inStack = new Set()
        }
        stack.push(stackHead)
        inStack.add(stackHead)
        stackHead = dep
        continue
      }
    } else {
      // All causal dependencies resolved — integrate `stackHead`
      const client = stackHead.id.client
      const localClock = map.setIfUndefined(state, client, () => store.getClock(client))
      const offset = localClock - stackHead.id.clock
      if (offset < 0) {
        const skip = new Skip(createID(client, localClock), -offset)
        skip.integrate(transaction, 0)
      }
      stackHead.integrate(transaction, 0)
      state.set(client, math.max(stackHead.id.clock + stackHead.length, localClock))
      if (integratedClients !== null) {
        integratedClients.add(client)
      }
      if (stack.length > 0) {
        if (integratedOutOfOrder === null) {
          integratedOutOfOrder = new Set()
        }
        integratedOutOfOrder.add(stackHead)
      }
    }
    // iterate to next stackHead
    if (stack.length > 0) {
      stackHead = /** @type {Item | GC} */ (stack.pop())
      if (inStack !== null) {
        inStack.delete(stackHead)
      }
    } else {
      stackHead = nextMainStruct()
    }
  }
  if (deferred !== null && deferred.size > 0 && missingSV !== null) {
    /**
     * Group deduplicated deferred structs by client.
     * @type {Map<number, Array<Item | GC>>}
     */
    const deferredByClient = new Map()
    deferred.forEach(struct => {
      map.setIfUndefined(deferredByClient, struct.id.client, () => /** @type {Array<Item | GC>} */ ([])).push(struct)
    })
    const restStructs = new StructStore()
    deferredByClient.forEach((structs, client) => {
      structs.sort((a, b) => a.id.clock - b.id.clock)
      /**
       * @type {Array<Item | GC | Skip>}
       */
      const contiguous = []
      let prevEnd = structs[0].id.clock
      for (let i = 0; i < structs.length; i++) {
        const s = structs[i]
        const gap = s.id.clock - prevEnd
        if (gap > 0) {
          contiguous.push(new Skip(createID(client, prevEnd), gap))
        }
        contiguous.push(s)
        prevEnd = s.id.clock + s.length
      }
      restStructs.clients.set(client, contiguous)
    })
    const encoder = new UpdateEncoderV2()
    writeClientsStructs(encoder, restStructs, new Map())
    // write empty deleteset
    encoding.writeVarUint(encoder.restEncoder, 0) // => no need for an extra function call, just write 0 deletes
    return { missing: missingSV, update: encoder.toUint8Array() }
  }
  return null
}

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {UpdateDecoderV1 | UpdateDecoderV2} [structDecoder]
 *
 * @function
 */
export const readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) => {
  // Decode the full update (both structs and delete set) before starting a transaction or
  // mutating `doc.store`, so malformed/truncated updates fail atomically without partial state.
  const ss = readBlockSet(structDecoder)
  const ds = readIdSet(structDecoder)
  // Lamport clock monotonicity: an Item can never depend on itself or a future clock of its own client.
  ss.clients.forEach((blockRange, client) => {
    const refs = blockRange.refs
    for (let i = 0; i < refs.length; i++) {
      const struct = refs[i]
      if (struct.constructor === Item) {
        const item = /** @type {Item} */ (struct)
        const clock = item.id.clock
        const origin = item.origin
        const rightOrigin = item.rightOrigin
        const parent = item.parent
        if (
          (origin !== null && origin.client === client && origin.clock >= clock) ||
          (rightOrigin !== null && rightOrigin.client === client && rightOrigin.clock >= clock) ||
          (parent instanceof ID && parent.client === client && parent.clock >= clock)
        ) {
          throw error.create('Malformed update: item depends on same-client future or self ID')
        }
      }
    }
  })
  return ydoc.transact(transaction => {
    // force that transaction.local is set to non-local
    transaction.local = false
    let retry = false
    const doc = transaction.doc
    const store = doc.store
    // let start = performance.now()
    const knownState = createIdSet()
    ss.clients.forEach((_, client) => {
      const storeStructs = store.clients.get(client)
      if (storeStructs) {
        const last = storeStructs[storeStructs.length - 1]
        knownState.add(client, 0, last.id.clock + last.length)
        // remove known items from ss
        store.skips.clients.get(client)?.getIds().forEach(idrange => {
          knownState.delete(client, idrange.clock, idrange.len)
        })
      }
    })
    // remove known items from ss
    ss.exclude(knownState)
    // console.log('time to read structs: ', performance.now() - start) // @todo remove
    // start = performance.now()
    // console.log('time to merge: ', performance.now() - start) // @todo remove
    // start = performance.now()
    const pending = store.pendingStructs
    /**
     * @type {Set<number> | null}
     */
    const integratedClients = pending !== null ? new Set() : null
    const restStructs = integrateStructs(transaction, store, ss, integratedClients)
    if (pending !== null) {
      // check if we can apply something
      for (const [client, clock] of pending.missing) {
        if (
          /** @type {Set<number>} */ (integratedClients).has(client) ||
          (clock < store.getClock(client) && !store.skips.has(client, clock))
        ) {
          retry = true
          break
        }
      }
      if (restStructs) {
        // merge restStructs into store.pending
        for (const [client, clock] of restStructs.missing) {
          const mclock = pending.missing.get(client)
          if (mclock == null || mclock > clock) {
            pending.missing.set(client, clock)
          }
        }
        pending.update = mergeUpdatesV2([pending.update, restStructs.update])
      }
    } else {
      store.pendingStructs = restStructs
    }
    // console.log('time to integrate: ', performance.now() - start) // @todo remove
    // start = performance.now()
    const dsRest = applyDeleteSet(ds, transaction, store)
    if (store.pendingDs) {
      // @todo we could make a lower-bound state-vector check as we do above
      const pendingDSUpdate = new UpdateDecoderV2(decoding.createDecoder(store.pendingDs))
      decoding.readVarUint(pendingDSUpdate.restDecoder) // read 0 structs, because we only encode deletes in pendingdsupdate
      const dsRest2 = readAndApplyDeleteSet(pendingDSUpdate, transaction, store)
      if (dsRest && dsRest2) {
        // case 1: ds1 != null && ds2 != null
        store.pendingDs = mergeUpdatesV2([dsRest, dsRest2])
      } else {
        // case 2: ds1 != null
        // case 3: ds2 != null
        // case 4: ds1 == null && ds2 == null
        store.pendingDs = dsRest || dsRest2
      }
    } else {
      // Either dsRest == null && pendingDs == null OR dsRest != null
      store.pendingDs = dsRest
    }
    // console.log('time to cleanup: ', performance.now() - start) // @todo remove
    // start = performance.now()

    // console.log('time to resume delete readers: ', performance.now() - start) // @todo remove
    // start = performance.now()
    if (retry) {
      const update = /** @type {{update: Uint8Array}} */ (store.pendingStructs).update
      store.pendingStructs = null
      applyUpdateV2(transaction.doc, update)
    }
  }, transactionOrigin, false)
}

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const readUpdate = (decoder, ydoc, transactionOrigin) => readUpdateV2(decoder, ydoc, transactionOrigin, new UpdateDecoderV1(decoder))

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 *
 * @function
 */
export const applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
  const decoder = decoding.createDecoder(update)
  readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder))
}

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1)

/**
 * Write all the document as a single update message. If you specify the state of the remote client (`targetStateVector`) it will
 * only write the operations that are missing.
 *
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Doc} doc
 * @param {Map<number,number>} [targetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 *
 * @function
 */
export const writeStateAsUpdate = (encoder, doc, targetStateVector = new Map()) => {
  writeClientsStructs(encoder, doc.store, targetStateVector)
  writeIdSet(encoder, doc.store.ds)
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @param {UpdateEncoderV1 | UpdateEncoderV2} [encoder]
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateAsUpdateV2 = (doc, encodedTargetStateVector = new Uint8Array([0]), encoder = new UpdateEncoderV2()) => {
  const targetStateVector = decodeStateVector(encodedTargetStateVector)
  writeStateAsUpdate(encoder, doc, targetStateVector)
  const updates = [encoder.toUint8Array()]
  // also add the pending updates (if there are any)
  if (doc.store.pendingDs) {
    updates.push(doc.store.pendingDs)
  }
  if (doc.store.pendingStructs) {
    updates.push(diffUpdateV2(doc.store.pendingStructs.update, encodedTargetStateVector))
  }
  if (updates.length > 1) {
    if (encoder.constructor === UpdateEncoderV1) {
      return mergeUpdates(updates.map((update, i) => i === 0 ? update : convertUpdateFormatV2ToV1(update)))
    } else if (encoder.constructor === UpdateEncoderV2) {
      return mergeUpdatesV2(updates)
    }
  }
  return updates[0]
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new UpdateEncoderV1())

/**
 * Read state vector from Decoder and return as Map
 *
 * @param {IdSetDecoderV1 | IdSetDecoderV2} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const readStateVector = decoder => {
  const ss = new Map()
  const restDecoder = decoder.restDecoder
  const ssLength = decoding.readVarUint(restDecoder)
  if (ssLength * 2 > restDecoder.arr.length - restDecoder.pos) {
    throw error.create('Unexpected end of array')
  }
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(restDecoder)
    const clock = decoding.readVarUint(restDecoder)
    if (client > number.MAX_SAFE_INTEGER || clock > number.MAX_SAFE_INTEGER || ss.has(client)) {
      throw error.unexpectedCase()
    }
    ss.set(client, clock)
  }
  return ss
}

/**
 *
 * This function works similarly to `readUpdateV2`.
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 * @return {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  if (updates.length === 1) {
    return updates[0]
  } else if (updates.length === 0) {
    return encodeStateAsUpdateV2(new Doc(), new Uint8Array([0]), new YEncoder())
  }
  const updateDecoders = updates.map(update => new YDecoder(decoding.createDecoder(update)))
  const blocksets = updateDecoders.map(dec => readBlockSet(dec))

  const mergedBlockset = blocksets[0]
  for (let i = 1; i < blocksets.length; i++) {
    mergedBlockset.insertInto(blocksets[i])
  }
  const updateEncoder = new YEncoder()
  writeBlockSet(updateEncoder, mergedBlockset)
  const dss = updateDecoders.map(decoder => readIdSet(decoder))
  const ds = mergeIdSets(dss)
  writeIdSet(updateEncoder, ds)
  return updateEncoder.toUint8Array()
}

/**
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @return {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdates = updates => mergeUpdatesV2(updates, UpdateDecoderV1, UpdateEncoderV1)

/**
 * @deprecated
 * @param {Uint8Array} update
 * @param {Uint8Array} sv
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 */
export const diffUpdateV2 = (update, sv, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  const state = decodeStateVector(sv)
  const encoder = new YEncoder()
  const lazyStructWriter = new LazyStructWriter(encoder)
  const decoder = new YDecoder(decoding.createDecoder(update))
  const reader = new LazyStructReader(decoder, false)
  while (reader.curr) {
    const curr = reader.curr
    const currClient = curr.id.client
    const svClock = state.get(currClient) || 0
    if (reader.curr.constructor === Skip) {
      // the first written struct shouldn't be a skip
      reader.next()
      continue
    }
    if (curr.id.clock + curr.length > svClock) {
      writeStructToLazyStructWriter(lazyStructWriter, curr, math.max(svClock - curr.id.clock, 0), 0)
      reader.next()
      while (reader.curr && reader.curr.id.client === currClient) {
        writeStructToLazyStructWriter(lazyStructWriter, reader.curr, 0, 0)
        reader.next()
      }
    } else {
      // read until something new comes up
      while (reader.curr && reader.curr.id.client === currClient && reader.curr.id.clock + reader.curr.length <= svClock) {
        reader.next()
      }
    }
  }
  finishLazyStructWriting(lazyStructWriter)
  // write ds
  const ds = readIdSet(decoder)
  writeIdSet(encoder, ds)
  return encoder.toUint8Array()
}

/**
 * @deprecated
 * @todo remove this in favor of intersectupdate
 *
 * @param {Uint8Array<ArrayBuffer>} update
 * @param {Uint8Array<ArrayBuffer>} sv
 */
export const diffUpdate = (update, sv) => diffUpdateV2(update, sv, UpdateDecoderV1, UpdateEncoderV1)

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
// export const decodeStateVectorV2 = decodedState => readStateVector(new DSDecoderV2(decoding.createDecoder(decodedState)))

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const decodeStateVector = decodedState => readStateVector(new IdSetDecoderV1(decoding.createDecoder(decodedState)))

/**
 * @param {IdSetEncoderV1 | IdSetEncoderV2} encoder
 * @param {Map<number,number>} sv
 * @function
 */
export const writeStateVector = (encoder, sv) => {
  encoding.writeVarUint(encoder.restEncoder, sv.size)
  array.from(sv.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    encoding.writeVarUint(encoder.restEncoder, client) // @todo use a special client decoder that is based on mapping
    encoding.writeVarUint(encoder.restEncoder, clock)
  })
  return encoder
}

/**
 * @param {IdSetEncoderV1 | IdSetEncoderV2} encoder
 * @param {Doc} doc
 *
 * @function
 */
export const writeDocumentStateVector = (encoder, doc) => writeStateVector(encoder, getStateVector(doc.store))

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @param {IdSetEncoderV1 | IdSetEncoderV2} [encoder]
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateVectorV2 = (doc, encoder = new IdSetEncoderV2()) => {
  if (doc instanceof Map) {
    writeStateVector(encoder, doc)
  } else {
    writeDocumentStateVector(encoder, doc)
  }
  return encoder.toUint8Array()
}

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @return {Uint8Array<ArrayBuffer>}
 *
 * @function
 */
export const encodeStateVector = doc => encodeStateVectorV2(doc, new IdSetEncoderV1())

/**
 * Return the ID of a missing causal dependency, or define missing items and return null.
 *
 * @param {Item} struct
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @return {null | ID}
 */
const getMissing = (struct, transaction, store) => {
  if (struct.constructor !== Item) return null
  // we may not access these variables anymore after they have been written!
  const origin = struct.origin
  const rightOrigin = struct.rightOrigin
  const parent = struct.parent
  if (origin && (origin.clock >= store.getClock(origin.client) || store.skips.hasId(origin))) {
    return origin
  }
  if (rightOrigin && (rightOrigin.clock >= store.getClock(rightOrigin.client) || store.skips.hasId(rightOrigin))) {
    return rightOrigin
  }
  if (parent && parent.constructor === ID && (parent.clock >= store.getClock(parent.client) || store.skips.hasId(parent))) {
    return parent
  }
  // We have all missing ids, now find the items
  if (origin) {
    struct.left = getItemCleanEnd(transaction, store, origin)
    // copy left id to so that the original id can be gc'd
    struct.origin = struct.left.lastId
  }
  if (rightOrigin) {
    struct.right = getItemCleanStart(transaction, rightOrigin)
    struct.rightOrigin = struct.right.id
  }
  if ((struct.left && struct.left.constructor === GC) || (struct.right && struct.right.constructor === GC)) {
    struct.parent = null
  } else if (parent == null) {
    // only set parent if this shouldn't be garbage collected
    if (struct.left && struct.left.constructor === Item) {
      struct.parent = struct.left.parent
      struct.parentSub = struct.left.parentSub
    } else if (struct.right && struct.right.constructor === Item) {
      struct.parent = struct.right.parent
      struct.parentSub = struct.right.parentSub
    }
  } else if (parent.constructor === ID) {
    const parentItem = store.getItem(parent)
    if (parentItem.constructor === GC) {
      struct.parent = null
    } else {
      struct.parent = /** @type {ContentType} */ (parentItem.content).type
    }
  } else if (typeof parent === 'string') {
    struct.parent = transaction.doc.get(parent)
  }
  return null
}

/**
 * @param {Uint8Array} update
 * @param {import('./Doc.js').DocOpts} opts
 */
export const createDocFromUpdate = (update, opts = {}) => {
  const ydoc = new Doc(opts)
  applyUpdate(ydoc, update)
  return ydoc
}

/**
 * @param {Uint8Array} update
 * @param {import('./Doc.js').DocOpts} opts
 */
export const createDocFromUpdateV2 = (update, opts = {}) => {
  const ydoc = new Doc(opts)
  applyUpdateV2(ydoc, update)
  return ydoc
}

/**
 * Create a copy of `ydoc` in exactly its state — including what it has received but cannot
 * integrate yet.
 *
 * Only the integrated content is encoded and applied; the pending structs and deletes are carried
 * over as they are. Encoding them into the same update (as `encodeStateAsUpdate` does) is not
 * faithful: a pending struct that lies inside a gap of its client merges with that client's
 * integrated structs behind the gap, and the clone would defer those too.
 *
 * @param {Doc} ydoc
 * @param {import('./Doc.js').DocOpts} [opts]
 */
export const cloneDoc = (ydoc, opts) => {
  const clone = new Doc(opts)
  const encoder = new UpdateEncoderV2()
  writeStateAsUpdate(encoder, ydoc)
  applyUpdateV2(clone, encoder.toUint8Array())
  const { pendingStructs, pendingDs } = ydoc.store
  // the pending updates are never mutated, only replaced — share them; `missing` is mutated
  if (pendingStructs !== null) clone.store.pendingStructs = { missing: new Map(pendingStructs.missing), update: pendingStructs.update }
  if (pendingDs !== null) clone.store.pendingDs = pendingDs
  return clone
}
