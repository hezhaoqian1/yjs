import * as Y from '../../src/index.js'
import * as encoding from 'lib0/encoding'
import { assertInvariant, InvariantError, verifyDocInvariants } from './invariants.js'

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   targetPr: string,
 *   run: () => void
 * }} BugReproducer
 */

/**
 * Read observer listener count for an event name on a Doc.
 *
 * @param {Doc} doc
 * @param {string} eventName
 * @return {number}
 */
const observerCount = (doc, eventName) => {
  const set = doc._observers.get(eventName)
  return set === undefined ? 0 : set.size
}

/** @type {Array<BugReproducer>} */
export const REPRODUCERS = [
  {
    id: 'BUG-1a',
    title: 'UndoManager followRedone over-deletes merged untracked text',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      const ytext = doc.get('text')
      const um = new Y.UndoManager(ytext, { captureTimeout: 0 })
      try {
        // Tx1 (tracked): S1.inserts = (1, 0..5) 'hello'
        ytext.insert(0, 'hello')
        um.stopCapturing()
        // Tx2 (untracked, same client): 'world' merges into single Item(1, 0..10, 'helloworld')
        doc.transact(() => {
          ytext.insert(5, 'world')
        }, 'untracked')
        assertInvariant(ytext.toString() === 'helloworld', `Expected 'helloworld', got '${ytext.toString()}'`)
        // Tx3 (tracked): deletes entire merged Item(1, 0..10) -> S2.deletes = (1, 0..10)
        ytext.delete(0, 10)
        um.stopCapturing()
        // First undo (S2): recreates Item(1, 10..20, 'helloworld') and sets (1,0..10).redone = (1,10)
        um.undo()
        assertInvariant(ytext.toString() === 'helloworld', `Expected 'helloworld' after undo S2, got '${ytext.toString()}'`)
        // Second undo (S1): must undo ONLY (1, 0..5) 'hello', preserving untracked 'world'
        um.undo()
        assertInvariant(
          ytext.toString() === 'world',
          `BUG-1a: UndoManager over-deleted untracked text! Expected 'world', got '${ytext.toString()}'`
        )
        verifyDocInvariants(doc, { expectNoPending: true, label: 'BUG-1a' })
      } finally {
        um.destroy()
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-1b',
    title: 'UndoManager followRedone under-deletes when redone item was split',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      const ytext = doc.get('text')
      const um = new Y.UndoManager(ytext, { captureTimeout: 0 })
      try {
        ytext.insert(0, 'ab')
        um.stopCapturing()
        ytext.delete(0, 2)
        um.stopCapturing()
        // Restore 'ab' -> sets (1,0..2).redone = (1,2)
        um.undo()
        assertInvariant(ytext.toString() === 'ab', `Expected 'ab' after first undo, got '${ytext.toString()}'`)
        // Untracked insert 'Z' in the middle splits redone Item(1,2,'ab') into 'a' + 'Z' + 'b'
        doc.transact(() => {
          ytext.insert(1, 'Z')
        }, 'untracked')
        assertInvariant(ytext.toString() === 'aZb', `Expected 'aZb', got '${ytext.toString()}'`)
        // Undoing the original 'ab' insert must delete BOTH 'a' and 'b', leaving only 'Z'
        um.undo()
        assertInvariant(
          ytext.toString() === 'Z',
          `BUG-1b: UndoManager under-deleted split redone item! Expected 'Z', got '${ytext.toString()}'`
        )
        verifyDocInvariants(doc, { expectNoPending: true, label: 'BUG-1b' })
      } finally {
        um.destroy()
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-2',
    title: 'UndoManager + gc:true ancestor keep clobbering via clear(false, true)',
    targetPr: 'PR #2',
    run: () => {
      const doc1 = new Y.Doc({ gc: true })
      doc1.clientID = 1
      const doc2 = new Y.Doc({ gc: true })
      doc2.clientID = 2
      const root1 = doc1.get('root')
      const child1 = new Y.Node()
      root1.insert(0, [child1])
      child1.insert(0, 'keep-me')
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))

      const keepMeItem = child1._start
      if (keepMeItem === null) throw new InvariantError('Expected child1._start item')
      const keepMeId = Y.createID(keepMeItem.id.client, keepMeItem.id.clock)
      const childWrapperItem = child1._item
      if (childWrapperItem === null) throw new InvariantError('Expected child1._item wrapper')

      const um = new Y.UndoManager(root1, { captureTimeout: 0 })
      try {
        // Delete 'keep-me' -> undoStack[0] holds its deletion and marks child1._item.keep = true
        child1.delete(0, 7)
        um.stopCapturing()
        // Insert 'temp' -> undoStack[1]
        child1.insert(0, 'temp')
        um.stopCapturing()
        // Undo 'temp' insert -> redoStack[0].deletes contains 'temp' inside child1
        um.undo()
        assertInvariant(um.undoStack.length === 1 && um.redoStack.length === 1, 'Expected 1 undo and 1 redo item')
        // Clearing ONLY redoStack must NOT clobber ancestor child1._item.keep needed by undoStack[0]
        um.clear(false, true)
        assertInvariant(
          childWrapperItem.keep === true,
          'BUG-2: clear(false, true) clobbered ancestor child1._item.keep to false while undoStack still needs it'
        )
        // Remote peer deletes child1 and syncs under gc:true
        doc2.get('root').delete(0, 1)
        Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)))
        const storedAfterGc = doc1.store.get(keepMeId)
        assertInvariant(
          storedAfterGc instanceof Y.Item && !(storedAfterGc.content instanceof Y.ContentDeleted),
          `BUG-2: kept child tombstone was destroyed by GC (${storedAfterGc.constructor.name})`
        )
        verifyDocInvariants(doc1, { expectNoPending: true, label: 'BUG-2' })
      } finally {
        um.destroy()
        doc1.destroy()
        doc2.destroy()
      }
    }
  },
  {
    id: 'BUG-3',
    title: 'delete(0, 1) on empty Y.Node crashes deleteText with TypeError',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc()
      const ytext = doc.get('text')
      try {
        /** @type {unknown} */
        let caught = null
        try {
          ytext.delete(0, 1)
        } catch (err) {
          caught = err
        }
        assertInvariant(
          !(caught instanceof TypeError),
          `BUG-3: delete(0, 1) on empty Y.Node threw null-dereference TypeError: ${String(caught)}`
        )
        verifyDocInvariants(doc, { expectNoPending: true, label: 'BUG-3' })
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-4',
    title: 'undoContentIds leaks permanent UndoManager listeners on ydoc',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      try {
        doc.get('text').insert(0, 'hello')
        const cids = Y.createContentIdsFromDoc(doc, true)
        const beforeAfterTr = observerCount(doc, 'afterTransaction')
        const beforeDestroy = observerCount(doc, 'destroy')

        Y.undoContentIds(doc, cids)
        doc.get('text').insert(0, 'world')
        Y.undoContentIds(doc, Y.createContentIdsFromDoc(doc, true))

        const afterAfterTr = observerCount(doc, 'afterTransaction')
        const afterDestroy = observerCount(doc, 'destroy')
        assertInvariant(
          afterAfterTr === beforeAfterTr && afterDestroy === beforeDestroy,
          `BUG-4: undoContentIds leaked listeners (afterTransaction: ${beforeAfterTr}->${afterAfterTr}, destroy: ${beforeDestroy}->${afterDestroy})`
        )
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-5',
    title: 'redoItem crashes when redone parent target was deleted and GCd',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc({ gc: true })
      doc.clientID = 1
      const root = doc.get('root')
      const child = new Y.Node()
      root.insert(0, [child])
      child.setAttr('k', 'v1')

      const um1 = new Y.UndoManager(root, { captureTimeout: 0, trackedOrigins: new Set(['o1']) })
      const um2 = new Y.UndoManager(root, { captureTimeout: 0, trackedOrigins: new Set(['o2']) })
      try {
        // o1 deletes map attr 'k' inside child
        doc.transact(() => {
          child.deleteAttr('k')
        }, 'o1')
        // o2 deletes child, undoes (creates child2 with child._item.redone = child2._item.id), then redoes (deletes child2)
        doc.transact(() => {
          root.delete(0, 1)
        }, 'o2')
        um2.undo()
        um2.redo()
        // Clearing um2 releases child2._item.keep -> retroactive GC replaces child2._item.content with ContentDeleted
        um2.clear(true, true)
        Y.gcIdSet(doc, Y.createDeleteSetFromStructStore(doc.store))

        // Now um1.undo() follows child._item.redone -> child2._item (deleted & ContentDeleted!)
        // Must NOT throw TypeError (e.g. reading '_map' on undefined) or corrupt invariants
        try {
          um1.undo()
        } catch (err) {
          assertInvariant(false, `BUG-5: redoItem crashed on GCd/deleted redone parent: ${String(err)}`)
        }
        verifyDocInvariants(doc, { expectNoPending: true, label: 'BUG-5' })
      } finally {
        um1.destroy()
        um2.destroy()
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-6',
    title: 'UndoManager permanently leaks keep=true after destroy() and redoItem()',
    targetPr: 'PR #2',
    run: () => {
      // Part A: um.destroy() without prior clear() leaves deleted items permanently keep=true
      const docA = new Y.Doc({ gc: true })
      docA.clientID = 1
      const textA = docA.get('text')
      const umA = new Y.UndoManager(textA, { captureTimeout: 0 })
      try {
        textA.insert(0, 'leakA')
        umA.stopCapturing()
        textA.delete(0, 5)
        umA.destroy()
        let keptAfterDestroy = 0
        for (const structs of docA.store.clients.values()) {
          for (let i = 0; i < structs.length; i++) {
            const s = structs[i]
            if (s instanceof Y.Item && s.keep) keptAfterDestroy++
          }
        }
        assertInvariant(
          keptAfterDestroy === 0,
          `BUG-6(A): um.destroy() left ${keptAfterDestroy} item(s) permanently keep=true`
        )
      } finally {
        docA.destroy()
      }

      // Part B: redoItem() sets keep=true on live redoneItem which even clear()+destroy() never releases
      const docB = new Y.Doc({ gc: true })
      docB.clientID = 1
      const textB = docB.get('text')
      const umB = new Y.UndoManager(textB, { captureTimeout: 0 })
      try {
        textB.insert(0, 'leakB')
        umB.stopCapturing()
        textB.delete(0, 5)
        umB.stopCapturing()
        umB.undo()
        umB.clear(true, true)
        umB.destroy()
        // Delete redone text under gc:true -> must be GC'd into ContentDeleted, not pinned forever
        textB.delete(0, 5)
        let keptRedone = 0
        for (const structs of docB.store.clients.values()) {
          for (let i = 0; i < structs.length; i++) {
            const s = structs[i]
            if (s instanceof Y.Item && s.keep) keptRedone++
          }
        }
        assertInvariant(
          keptRedone === 0,
          `BUG-6(B): redoItem() left ${keptRedone} redone item(s) permanently keep=true after clear()+destroy()+delete`
        )
      } finally {
        docB.destroy()
      }
    }
  },
  {
    id: 'BUG-7',
    title: 'gcIdSet crashes on unknown client or out-of-range clock',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      try {
        doc.get('text').insert(0, 'hello')
        doc.get('text').delete(0, 5)

        const unknownClientIds = Y.createIdSet()
        unknownClientIds.add(999999, 0, 5)
        try {
          Y.gcIdSet(doc, unknownClientIds)
        } catch (err) {
          assertInvariant(false, `BUG-7: gcIdSet crashed on unknown client: ${String(err)}`)
        }

        const oobClockIds = Y.createIdSet()
        oobClockIds.add(1, 500, 10)
        try {
          Y.gcIdSet(doc, oobClockIds)
        } catch (err) {
          assertInvariant(false, `BUG-7: gcIdSet crashed on out-of-range clock: ${String(err)}`)
        }

        verifyDocInvariants(doc, { expectNoPending: true, label: 'BUG-7' })
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-8',
    title: 'Regression (PR #1): applyDeleteSet partial-Skip overlap puts only [7,10) in pendingDs',
    targetPr: 'PR #1',
    run: () => {
      const src = new Y.Doc({ gc: false })
      src.clientID = 42
      const dst = new Y.Doc({ gc: false })
      dst.clientID = 1
      try {
        // Produce clock 0..10 on 'other' and independent clock 10..15 on 'text'
        src.get('other').insert(0, '0123456789')
        src.get('text').insert(0, 'abcde')
        const fullUpdate = Y.encodeStateAsUpdate(src)

        // Build state vector { 42: 10 } so diffUpdate yields only clock [10, 15)
        const svEnc = encoding.createEncoder()
        encoding.writeVarUint(svEnc, 1)
        encoding.writeVarUint(svEnc, 42)
        encoding.writeVarUint(svEnc, 10)
        const tailUpdate = Y.diffUpdate(fullUpdate, encoding.toUint8Array(svEnc))

        // Applying tailUpdate creates [Skip(42, 0, len=10), Item(42, 10, len=5, 'abcde')]
        Y.applyUpdate(dst, tailUpdate)
        assertInvariant(dst.store.skips.covers(42, 0, 10), 'Expected Skip [0, 10) for client 42')
        assertInvariant(dst.get('text').toString() === 'abcde', 'Expected tail text "abcde"')

        // Craft a V1 delete-only update deleting [7, 15) (clock=7, len=8) across Skip + Item boundary
        const delEnc = encoding.createEncoder()
        encoding.writeVarUint(delEnc, 0) // 0 structs
        encoding.writeVarUint(delEnc, 1) // 1 client in deleteSet
        encoding.writeVarUint(delEnc, 42) // client 42
        encoding.writeVarUint(delEnc, 1) // 1 delete range
        encoding.writeVarUint(delEnc, 7) // clock = 7
        encoding.writeVarUint(delEnc, 8) // len = 8 -> [7, 15)
        Y.applyUpdate(dst, encoding.toUint8Array(delEnc))

        // [10, 15) must already be deleted; pendingDs must hold ONLY [7, 10), NOT [7, 15)!
        assertInvariant(dst.get('text').length === 0, 'Expected Item [10, 15) to be deleted')
        const pendingDs = dst.store.pendingDs
        if (pendingDs === null) throw new InvariantError('Expected pendingDs for unapplied Skip overlap [7, 10)')
        const decodedPending = Y.decodeUpdateV2(pendingDs).ds
        const ranges = decodedPending.clients.get(42)?.getIds() ?? []
        assertInvariant(
          ranges.length === 1 && ranges[0].clock === 7 && ranges[0].len === 3,
          `BUG-8: pendingDs should contain only [7, 10), got ${JSON.stringify(ranges)}`
        )
        assertInvariant(
          !decodedPending.intersects(42, 10, 5),
          'BUG-8: pendingDs erroneously included already-deleted range [10, 15)'
        )

        // Applying fullUpdate fills [0, 10) and drains pendingDs cleanly
        Y.applyUpdate(dst, fullUpdate)
        assertInvariant(dst.store.pendingDs === null, 'Expected pendingDs === null after healing Skip')
        assertInvariant(dst.get('other').toString() === '0123456', `Expected '0123456', got '${dst.get('other').toString()}'`)
        verifyDocInvariants(dst, { expectNoPending: true, label: 'BUG-8' })
      } finally {
        src.destroy()
        dst.destroy()
      }
    }
  },
  {
    id: 'BUG-PENDING-STUCK',
    title: 'integrateStructs addStackToRestSS head-of-line blocks independent later structs of same client, breaking partial commutativity & duplicate replay idempotency',
    targetPr: 'PR #2',
    run: () => {
      const src = new Y.Doc({ gc: false })
      src.clientID = 1
      /** @type {Array<Uint8Array<ArrayBuffer>>} */
      const updates = []
      src.on('update', u => {
        updates.push(u)
      })
      const m = src.get('map')
      const sub1 = new Y.Node()
      m.setAttr('a', sub1) // updates[0]: clock 0 (sub1)
      sub1.insert(0, [100]) // updates[1]: clock 1 (parent = ID(1, 0))
      const sub2 = new Y.Node()
      m.setAttr('b', sub2) // updates[2]: clock 2 (sub2, root 'map')
      sub2.insert(0, [200]) // updates[3]: clock 3 (parent = ID(1, 2))

      const doc1 = new Y.Doc({ gc: false })
      const doc2 = new Y.Doc({ gc: false })
      try {
        // Apply same partial update set {u1, u2, u3} (missing u0) in two different orders:
        // doc1: u1 -> u3 -> u2 (u3 merges behind blocked u1 in pendingStructs; retry HOL-blocks u3!)
        Y.applyUpdate(doc1, updates[1])
        Y.applyUpdate(doc1, updates[3])
        Y.applyUpdate(doc1, updates[2])

        // doc2: u1 -> u2 -> u3 (u2 integrates first, so u3 integrates immediately!)
        Y.applyUpdate(doc2, updates[1])
        Y.applyUpdate(doc2, updates[2])
        Y.applyUpdate(doc2, updates[3])

        const json1BeforeDup = JSON.stringify(doc1.get('map').toJSON())
        const json2 = JSON.stringify(doc2.get('map').toJSON())

        // Replaying already-received updates[3] onto doc1 must be strictly idempotent
        Y.applyUpdate(doc1, updates[3])
        const json1AfterDup = JSON.stringify(doc1.get('map').toJSON())

        assertInvariant(
          json1BeforeDup === json2,
          `BUG-PENDING-STUCK (commutativity): {u1,u3,u2} diverged from {u1,u2,u3}: doc1=${json1BeforeDup} vs doc2=${json2}`
        )
        assertInvariant(
          json1BeforeDup === json1AfterDup,
          `BUG-PENDING-STUCK (idempotency): duplicate applyUpdate(u3) mutated doc1 from ${json1BeforeDup} to ${json1AfterDup}`
        )
        verifyDocInvariants(doc1, { expectNoPending: false, label: 'BUG-PENDING-STUCK:doc1' })
        verifyDocInvariants(doc2, { expectNoPending: false, label: 'BUG-PENDING-STUCK:doc2' })
      } finally {
        src.destroy()
        doc1.destroy()
        doc2.destroy()
      }
    }
  },
  {
    id: 'ID-COPY-1',
    title: 'IdRanges.copy() fails to set cpy._lastIsUsed=true, aliasing mutations back to source IdSet',
    targetPr: 'PR #2',
    run: () => {
      const src = Y.createIdSet()
      src.add(1, 0, 5)
      const dest = Y.createIdSet()
      // insertIntoIdSet clones src's IdRanges via srcRanges.copy() when client 1 is absent in dest
      Y.insertIntoIdSet(dest, src)
      // Extending dest's contiguous last range must NOT mutate src's IdRange in place!
      dest.add(1, 5, 3)
      const srcRanges = src.clients.get(1)?.getIds() ?? []
      assertInvariant(
        srcRanges.length === 1 && srcRanges[0].clock === 0 && srcRanges[0].len === 5 && !src.has(1, 5),
        `ID-COPY-1: mutating copied IdSet aliased back into source IdSet (src range len=${srcRanges[0]?.len}, expected 5)`
      )
    }
  },
  {
    id: 'BUG-11',
    title: 'Item.mergeWith searchMarker BIT4 clear / duplicate marker corruption',
    targetPr: 'PR #2',
    run: () => {
      // Sub-case A: marker reassigned from right -> left during mergeWith fails to set left.marker (BIT4)
      const doc1 = new Y.Doc({ gc: false })
      doc1.clientID = 1
      const doc2 = new Y.Doc({ gc: false })
      doc2.clientID = 2
      try {
        doc2.get('array').insert(0, [0])
        Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))
        const arr1 = doc1.get('array')
        arr1.insert(1, [10])
        arr1.delete(1, 1) // Item(1, 0) deleted
        arr1.insert(1, [20]) // Item(1, 1) alive
        Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)))
        doc2.get('array').insert(2, [99]) // Item(2, 1) alive at index 2
        Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)))

        // Place marker m0 on Item(1, 0) (via findMarker walk-left) and marker m1 on Item(2, 1)
        assertInvariant(arr1.get(1) === 20, 'Expected 20 at index 1')
        assertInvariant(arr1.get(2) === 99, 'Expected 99 at index 2')

        // Delete Item(2, 1) then insert at index 2 -> updateMarkerChanges shifts m1 left onto Item(1, 1)
        arr1.delete(2, 1)
        arr1.insert(2, [30])
        // Delete Item(1, 1) -> tryMerge executes Item(1, 0).mergeWith(Item(1, 1))
        arr1.delete(1, 1)

        const markers = arr1._searchMarker
        if (markers === null) throw new InvariantError('Expected searchMarker array')
        /** @type {Set<Item>} */
        const seenTargets = new Set()
        for (let i = 0; i < markers.length; i++) {
          const m = markers[i]
          assertInvariant(
            m.p.marker === true,
            `BUG-11: searchMarker[${i}] target (${m.p.id.client},${m.p.id.clock}) has marker BIT4 === false after mergeWith`
          )
          assertInvariant(
            !seenTargets.has(m.p),
            `BUG-11: duplicate searchMarkers pointing to the same Item (${m.p.id.client},${m.p.id.clock}) after mergeWith`
          )
          seenTargets.add(m.p)
        }
        verifyDocInvariants(doc1, { expectNoPending: true, label: 'BUG-11' })
      } finally {
        doc1.destroy()
        doc2.destroy()
      }
    }
  },
  {
    id: 'BUG-13-STACK',
    title: 'Deleting deeply nested Y.Node chain (depth 12000) under gc:true overflows call stack in ContentType.delete/gc',
    targetPr: 'PR #2',
    run: () => {
      const depth = 12000
      const doc = new Y.Doc({ gc: true })
      doc.clientID = 1
      try {
        doc.transact(() => {
          let cur = doc.get('root')
          for (let i = 0; i < depth; i++) {
            const child = new Y.Node()
            cur.insert(0, [child])
            cur = child
          }
        })
        assertInvariant(doc.get('root').length === 1, 'Expected root child before delete')
        // Deleting the top-level nested node under gc:true must NOT trigger RangeError stack overflow
        try {
          doc.get('root').delete(0, 1)
        } catch (err) {
          assertInvariant(false, `BUG-13-STACK: deleting depth-${depth} Y.Node chain threw ${String(err)}`)
        }
        assertInvariant(doc.get('root').length === 0, 'Expected empty root after delete')
        verifyDocInvariants(doc, { expectNoPending: true, label: 'BUG-13-STACK' })
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'TX-1',
    title: 'Throwing once in beforeTransaction permanently bricks Doc',
    targetPr: 'PR #3',
    run: () => {
      const doc = new Y.Doc()
      doc.clientID = 1
      try {
        let shouldThrow = true
        doc.on('beforeTransaction', () => {
          if (shouldThrow) {
            shouldThrow = false
            throw new Error('boom-beforeTransaction')
          }
        })
        let updateCount = 0
        doc.on('update', () => {
          updateCount++
        })

        let threw = false
        try {
          doc.get('text').insert(0, 'first')
        } catch (_err) {
          threw = true
        }
        assertInvariant(threw, 'Expected beforeTransaction listener error to propagate')

        // Subsequent transactions must recover cleanly and fire update/observer events!
        doc.get('text').insert(0, 'second')
        assertInvariant(
          doc._transaction === null && doc._transactionCleanups.length === 0,
          `TX-1: Doc stuck in dirty transaction state (_transaction=${String(doc._transaction !== null)}, cleanups=${doc._transactionCleanups.length})`
        )
        assertInvariant(
          updateCount >= 1,
          `TX-1: Doc permanently bricked after beforeTransaction throw (updateCount=${updateCount}, expected >= 1)`
        )
        verifyDocInvariants(doc, { expectNoPending: true, label: 'TX-1' })
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'TX-2',
    title: 'Throwing once in update listener permanently bricks Doc',
    targetPr: 'PR #3',
    run: () => {
      const doc = new Y.Doc()
      doc.clientID = 1
      try {
        let shouldThrow = true
        let healthyUpdates = 0
        doc.on('update', () => {
          if (shouldThrow) {
            shouldThrow = false
            throw new Error('boom-update')
          }
          healthyUpdates++
        })

        let threw = false
        try {
          doc.get('text').insert(0, 'first')
        } catch (_err) {
          threw = true
        }
        assertInvariant(threw, 'Expected update listener error to propagate')

        // Subsequent transactions must still execute cleanupTransactions and emit update!
        doc.get('text').insert(doc.get('text').length, 'second')
        assertInvariant(
          doc._transactionCleanups.length === 0,
          `TX-2: _transactionCleanups leaked (${doc._transactionCleanups.length} stuck entries)`
        )
        assertInvariant(
          healthyUpdates >= 1,
          `TX-2: Doc permanently bricked after update listener throw (healthyUpdates=${healthyUpdates}, expected >= 1)`
        )
        verifyDocInvariants(doc, { expectNoPending: true, label: 'TX-2' })
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'DOC-1',
    title: 'Deleting subdoc under gc:true / parentDoc.destroy() corrupts ContentDeleted & leaks zombie subdocs',
    targetPr: 'PR #3',
    run: () => {
      // Part A: Deleting a subdoc under gc:true must not mutate ContentDeleted with .doc
      const parent1 = new Y.Doc({ gc: true })
      parent1.clientID = 1
      const sub1 = new Y.Doc({ guid: 'doc1-sub-gc' })
      try {
        parent1.get('arr').insert(0, [sub1])
        const subItem = parent1.get('arr')._start
        if (subItem === null) throw new InvariantError('Expected subdoc item')
        parent1.get('arr').delete(0, 1)
        assertInvariant(
          subItem.content instanceof Y.ContentDeleted,
          `Expected ContentDeleted after GC, got ${subItem.content.constructor.name}`
        )
        assertInvariant(
          !Object.prototype.hasOwnProperty.call(subItem.content, 'doc'),
          'DOC-1: subdoc.destroy() corrupted ContentDeleted by assigning .doc property onto it'
        )
        assertInvariant(
          parent1.subdocs.size === 0,
          `DOC-1: parent1.subdocs still has ${parent1.subdocs.size} subdoc(s) after delete`
        )
      } finally {
        parent1.destroy()
      }

      // Part B: parent.destroy() must not recreate and re-insert zombie subdocs into parent.subdocs
      const parent2 = new Y.Doc({ gc: true })
      parent2.clientID = 2
      const sub2 = new Y.Doc({ guid: 'doc1-sub-destroy' })
      parent2.get('arr').insert(0, [sub2])
      parent2.destroy()
      assertInvariant(
        parent2.subdocs.size === 0,
        `DOC-1: parent2.destroy() leaked ${parent2.subdocs.size} zombie subdoc(s) back into parent2.subdocs`
      )
    }
  },
  {
    id: 'R-1',
    title: 'diffDocsToDelta(v1, v2) leaks live DiffRenderer and replicates future v1 edits into v2',
    targetPr: 'PR #5',
    run: () => {
      const v1 = new Y.Doc({ gc: false })
      v1.clientID = 1
      v1.get('text').insert(0, 'hello')
      const v2 = Y.cloneDoc(v1, { gc: false })
      v2.clientID = 2
      v2.get('text').insert(5, ' world')
      try {
        const beforeV1UpdateObs = observerCount(v1, 'update')
        const d = Y.diffDocsToDelta(v1, v2)
        assertInvariant(!d.isEmpty(), 'Expected non-empty diff delta')

        // Subsequent edits to v1 MUST NOT leak into v2 via a dangling DiffRenderer!
        v1.get('text').insert(0, 'LEAKED_')
        assertInvariant(
          v2.get('text').toString() === 'hello world',
          `R-1: diffDocsToDelta leaked live DiffRenderer; v1 edit mutated v2 to '${v2.get('text').toString()}'`
        )
        const afterV1UpdateObs = observerCount(v1, 'update')
        assertInvariant(
          afterV1UpdateObs === beforeV1UpdateObs,
          `R-1: diffDocsToDelta leaked update observer on v1 (${beforeV1UpdateObs}->${afterV1UpdateObs})`
        )
      } finally {
        v1.destroy()
        v2.destroy()
      }
    }
  },
  {
    id: 'R-2',
    title: 'DiffRenderer.readContent mutates live AttrRange.len causing data loss on subsequent renders',
    targetPr: 'PR #5',
    run: () => {
      const base = new Y.Doc({ gc: false })
      base.clientID = 1
      base.get('text').insert(0, 'ab')

      const prevDoc = new Y.Doc({ gc: false })
      prevDoc.clientID = 2
      Y.applyUpdate(prevDoc, Y.encodeStateAsUpdate(base))
      // Split client 1's Item(1,0,'ab',len=2) in prevDoc into 'a'(len=1) + 'X' + 'b'(len=1)
      prevDoc.get('text').insert(1, 'X')

      const nextDoc = new Y.Doc({ gc: true })
      nextDoc.clientID = 3
      Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(base))
      // Delete 'ab' as one contiguous ContentDeleted(len=2) in nextDoc
      nextDoc.get('text').delete(0, 2)

      const renderer = Y.createDiffRenderer(prevDoc, nextDoc)
      try {
        const firstRender = nextDoc.get('text').toDelta({ renderer }).toJSON()
        const secondRender = nextDoc.get('text').toDelta({ renderer }).toJSON()

        const delRanges = renderer.deletes.clients.get(1)?.getIds() ?? []
        const totalDelLen = delRanges.reduce((sum, r) => sum + r.len, 0)
        assertInvariant(
          totalDelLen === 2,
          `R-2: DiffRenderer.readContent mutated live AttrRange.len in renderer.deletes (totalLen=${totalDelLen}, expected 2)`
        )
        assertInvariant(
          JSON.stringify(firstRender) === JSON.stringify(secondRender),
          `R-2: Second render diverged from first render due to live AttrRange mutation:\n  1st: ${JSON.stringify(firstRender)}\n  2nd: ${JSON.stringify(secondRender)}`
        )
      } finally {
        renderer.destroy()
        base.destroy()
        prevDoc.destroy()
        nextDoc.destroy()
      }
    }
  },
  {
    id: 'META-1',
    title: 'createContentIdsFromDocDiff(prev, next) returns empty when prev is a subset of next',
    targetPr: 'PR #5',
    run: () => {
      const prev = new Y.Doc({ gc: false })
      prev.clientID = 1
      prev.get('text').insert(0, 'a')

      const next = Y.cloneDoc(prev, { gc: false })
      next.clientID = 1
      next.get('text').insert(1, 'bc')

      try {
        const diff = Y.createContentIdsFromDocDiff(prev, next)
        assertInvariant(
          !diff.inserts.isEmpty(),
          'META-1: createContentIdsFromDocDiff(prev, next) returned empty inserts when next added "bc"'
        )
        assertInvariant(
          diff.inserts.covers(1, 1, 2) && !diff.inserts.has(1, 0),
          'META-1: createContentIdsFromDocDiff(prev, next) did not return exact delta range [clock=1, len=2)'
        )
      } finally {
        prev.destroy()
        next.destroy()
      }
    }
  }
]

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let listOnly = false
  let reportOnly = false
  /** @type {Array<string>} */
  let filters = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') {
      listOnly = true
    } else if (arg === '--report') {
      reportOnly = true
    } else if (arg === '--filter' && i + 1 < argv.length) {
      filters = argv[++i].split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/bug-reproducers.js [--list] [--filter id1,id2] [--report]')
      process.exit(0)
    }
  }
  return { listOnly, reportOnly, filters }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.listOnly) {
    for (let i = 0; i < REPRODUCERS.length; i++) {
      const r = REPRODUCERS[i]
      console.log(`${r.id.padEnd(8)} [${r.targetPr}] ${r.title}`)
    }
    process.exit(0)
  }

  const selected = args.filters.length === 0
    ? REPRODUCERS
    : REPRODUCERS.filter(r => args.filters.some(f => r.id.toLowerCase().includes(f) || r.targetPr.toLowerCase().includes(f)))

  if (selected.length === 0) {
    console.error(`No reproducers matched --filter=${args.filters.join(',')}`)
    process.exit(2)
  }

  const t0 = performance.now()
  let passed = 0
  let failed = 0

  console.log(`=== Yjs v14 Audited Bug Reproducers (${selected.length} tests, mode=${args.reportOnly ? 'report' : 'strict'}) ===`)
  for (let i = 0; i < selected.length; i++) {
    const rep = selected[i]
    const rt0 = performance.now()
    try {
      rep.run()
      passed++
      console.log(`  [PASS] ${rep.id.padEnd(8)} (${rep.targetPr}) ${rep.title} (${(performance.now() - rt0).toFixed(1)}ms)`)
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  [FAIL] ${rep.id.padEnd(8)} (${rep.targetPr}) ${rep.title} (${(performance.now() - rt0).toFixed(1)}ms)`)
      console.log(`         -> ${msg}`)
    }
  }

  console.log(`=== Summary: ${passed} passed, ${failed} failed in ${(performance.now() - t0).toFixed(1)}ms ===`)
  if (failed > 0 && !args.reportOnly) {
    process.exit(1)
  }
}
