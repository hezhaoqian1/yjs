import * as Y from '../../src/index.js'
import { writeStructsFromIdSet } from '../../src/utils/encoding-helpers.js'
import * as encoding from 'lib0/encoding'
import * as delta from 'lib0/delta'
import * as dpos from 'lib0/delta/position'
import { assertInvariant, equalBytes, InvariantError, verifyDocInvariants } from './invariants.js'

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
  },
  {
    id: 'BUG-DELTA-LEN1',
    title: 'YNode.toDelta hardcodes retain(1)/delete(1) on multi-element ContentAny/ContentJSON, corrupting live .delta & delta events',
    targetPr: 'PR #2b',
    run: () => {
      // Part A: Default fast path (src/ynode.js L1547) — sequential push reverses arr.delta & emits wrong retain(1)
      const docPush = new Y.Doc({ gc: false })
      docPush.clientID = 1
      const arrPush = docPush.get('array')
      const livePush = arrPush.delta
      /** @type {Array<unknown>} */
      const emittedPush = []
      const replayedPush = delta.create(delta.$deltaAny)
      replayedPush.isFinal = true
      arrPush.on('delta', d => {
        emittedPush.push(d.toJSON())
        replayedPush.apply(d)
      })

      // Part B: Default fast path (src/ynode.js L1504) — multi-element delete emits delete(1) leaving zombie elements
      const docDel = new Y.Doc({ gc: false })
      docDel.clientID = 2
      const arrDel = docDel.get('array')
      arrDel.insert(0, [10, 20, 30, 40])
      const liveDel = arrDel.delta
      /** @type {Array<unknown>} */
      const emittedDel = []
      arrDel.on('delta', d => emittedDel.push(d.toJSON()))

      // Part C1: AttributionsRenderer processContent path (src/ynode.js L1271) — retainContent on multi-element slice
      const docRendPush = new Y.Doc({ gc: false })
      docRendPush.clientID = 3
      const arrRendPush = docRendPush.get('array')
      const cmapPush = Y.createContentMap()
      cmapPush.inserts.add(3, 0, 1, [Y.createContentAttribute('insert', 'alice')])
      const rendPush = Y.createAttributionsRenderer(cmapPush)
      arrRendPush.useRenderer(rendPush)
      const liveRendPush = arrRendPush.delta

      // Part C2: AttributionsRenderer processContent path (src/ynode.js L1263) — renderDelete on multi-element slice
      const docRendDel = new Y.Doc({ gc: false })
      docRendDel.clientID = 4
      const arrRendDel = docRendDel.get('array')
      arrRendDel.insert(0, [10, 20, 30, 40])
      const cmapDel = Y.createContentMap()
      cmapDel.inserts.add(4, 0, 1, [Y.createContentAttribute('insert', 'bob')])
      const rendDel = Y.createAttributionsRenderer(cmapDel)
      arrRendDel.useRenderer(rendDel)
      const liveRendDel = arrRendDel.delta
      /** @type {Array<{ type: string, delete?: number }>} */
      const rendDelOps = []
      arrRendDel.on('delta', d => {
        for (const op of d.children) {
          if (delta.$deleteOp.check(op)) {
            rendDelOps.push({ type: 'delete', delete: op.delete })
          }
        }
      })

      try {
        // Execute Part A
        arrPush.push([0])
        arrPush.push([1])
        arrPush.push([2])
        arrPush.push([3])
        const freshPush = arrPush.toDeltaDeep()
        assertInvariant(
          JSON.stringify(arrPush.toArray()) === '[0,1,2,3]',
          `BUG-DELTA-LEN1(A): ground-truth array mismatch (${JSON.stringify(arrPush.toArray())})`
        )
        assertInvariant(
          livePush.equals(freshPush),
          `BUG-DELTA-LEN1(A): arr.delta corrupted on sequential push!\n  live:  ${JSON.stringify(livePush.toJSON())}\n  fresh: ${JSON.stringify(freshPush.toJSON())}`
        )
        assertInvariant(
          replayedPush.equals(freshPush),
          `BUG-DELTA-LEN1(A): replaying 'delta' events diverged from toDeltaDeep()!\n  replayed: ${JSON.stringify(replayedPush.toJSON())}\n  fresh:    ${JSON.stringify(freshPush.toJSON())}`
        )
        const expectedPush2 = JSON.stringify(delta.create(delta.$deltaAny).retain(2).insert([2]).done().toJSON())
        const expectedPush3 = JSON.stringify(delta.create(delta.$deltaAny).retain(3).insert([3]).done().toJSON())
        assertInvariant(
          emittedPush.length === 4 &&
          JSON.stringify(emittedPush[2]) === expectedPush2 &&
          JSON.stringify(emittedPush[3]) === expectedPush3,
          `BUG-DELTA-LEN1(A): incremental 'delta' events had wrong retain length (ev[2]=${JSON.stringify(emittedPush[2])}, ev[3]=${JSON.stringify(emittedPush[3])})`
        )

        // Execute Part B
        arrDel.delete(0, 3)
        const freshDel = arrDel.toDeltaDeep()
        assertInvariant(
          liveDel.equals(freshDel),
          `BUG-DELTA-LEN1(B): arr.delta under-deleted on delete(0, 3)!\n  live:  ${JSON.stringify(liveDel.toJSON())}\n  fresh: ${JSON.stringify(freshDel.toJSON())}`
        )
        const expectedDel3 = JSON.stringify(delta.create(delta.$deltaAny).delete(3).done().toJSON())
        assertInvariant(
          emittedDel.length === 1 && JSON.stringify(emittedDel[0]) === expectedDel3,
          `BUG-DELTA-LEN1(B): incremental 'delta' event emitted wrong delete length (got ${JSON.stringify(emittedDel[0])}, expected ${expectedDel3})`
        )

        // Execute Part C1 (AttributionsRenderer retainContent on len>1 ContentAny slice)
        arrRendPush.push([0])
        arrRendPush.push([1])
        arrRendPush.push([2])
        arrRendPush.push([3])
        const freshRendPush = arrRendPush.toDeltaDeep()
        assertInvariant(
          liveRendPush.equals(freshRendPush),
          `BUG-DELTA-LEN1(C1): AttributionsRenderer arr.delta corrupted on sequential push!\n  live:  ${JSON.stringify(liveRendPush.toJSON())}\n  fresh: ${JSON.stringify(freshRendPush.toJSON())}`
        )

        // Execute Part C2 (AttributionsRenderer renderDelete on len>1 ContentAny slice [20, 30])
        arrRendDel.delete(0, 3)
        /** @type {Array<unknown>} */
        const liveRendDelElems = []
        for (const op of liveRendDel.children) {
          if (delta.$insertOp.check(op)) {
            liveRendDelElems.push(...op.insert)
          }
        }
        assertInvariant(
          rendDelOps.length === 1 && rendDelOps[0].delete === 2,
          `BUG-DELTA-LEN1(C2): AttributionsRenderer 'delta' event emitted wrong delete length (got ${JSON.stringify(rendDelOps)}, expected delete=2 for [20, 30])`
        )
        assertInvariant(
          JSON.stringify(liveRendDelElems) === '[10,40]',
          `BUG-DELTA-LEN1(C2): AttributionsRenderer arr.delta left zombie elements on delete(0, 3)! got ${JSON.stringify(liveRendDelElems)}, expected [10,40]`
        )
      } finally {
        rendPush.destroy()
        rendDel.destroy()
        docPush.destroy()
        docDel.destroy()
        docRendPush.destroy()
        docRendDel.destroy()
      }
    }
  },
  {
    id: 'TX-3',
    title: 'cleanupYTextAfterTransaction runs transact(doc, ...) with default origin=null/local=true, polluting UndoManager undoStack & wiping redoStack',
    targetPr: 'PR #3',
    run: () => {
      const doc1 = new Y.Doc({ gc: false })
      const doc2 = new Y.Doc({ gc: false })
      doc1.clientID = 1
      doc2.clientID = 2
      const ytext1 = doc1.get('text')
      const ytext2 = doc2.get('text')
      ytext1.insert(0, 'hello')
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))

      const um = new Y.UndoManager(ytext1, { captureTimeout: 0 })
      try {
        // Build 1 undo entry + 1 redo entry on doc1 (with formatting active so _hasFormatting=true)
        ytext1.format(0, 5, { bold: true })
        um.stopCapturing()
        ytext1.insert(5, '!')
        um.stopCapturing()
        um.undo()
        assertInvariant(
          um.undoStack.length === 1 && um.redoStack.length === 1,
          `TX-3: setup expected undo=1,redo=1, got undo=${um.undoStack.length},redo=${um.redoStack.length}`
        )

        // Concurrently on doc2 (unaware of doc1's bold), apply the same bold format -> duplicate ContentFormat markers
        ytext2.format(0, 5, { bold: true })
        const remoteUpdate = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1))

        // Apply remote update with non-tracked origin 'remote' -> triggers cleanupYTextAfterTransaction
        Y.applyUpdate(doc1, remoteUpdate, 'remote')

        assertInvariant(
          um.undoStack.length === 1 && um.redoStack.length === 1,
          `TX-3: remote formatting cleanup polluted UndoManager! expected undo=1,redo=1, got undo=${um.undoStack.length},redo=${um.redoStack.length}`
        )
      } finally {
        um.destroy()
        doc1.destroy()
        doc2.destroy()
      }
    }
  },
  {
    id: 'DOC-2',
    title: 'subdoc.load() sets shouldLoad=true after transact(), so shouldLoad is still false inside synchronous parent subdocs callback',
    targetPr: 'PR #3',
    run: () => {
      const parent = new Y.Doc()
      const sub = new Y.Doc({ shouldLoad: false, autoLoad: false })
      /** @type {Array<boolean>} */
      const observedShouldLoad = []
      try {
        parent.get('array').insert(0, [sub])
        parent.on('subdocs', ({ loaded }) => {
          if (loaded.has(sub)) {
            observedShouldLoad.push(sub.shouldLoad)
          }
        })
        sub.load()
        assertInvariant(
          observedShouldLoad.length === 1 && observedShouldLoad[0] === true,
          `DOC-2: inside parent 'subdocs' callback, subdoc.shouldLoad was ${JSON.stringify(observedShouldLoad)} (expected [true])`
        )
      } finally {
        sub.destroy()
        parent.destroy()
      }
    }
  },
  {
    id: 'R-3',
    title: 'DiffRenderer.rejectChanges assigns shorter prevDoc Content onto longer GCd ContentDeleted Item, breaking Item.length === content.getLength()',
    targetPr: 'PR #5',
    run: () => {
      const base = new Y.Doc({ gc: false })
      base.clientID = 1
      base.get('text').insert(0, 'ab')

      const prevDoc = new Y.Doc({ gc: false })
      prevDoc.clientID = 2
      Y.applyUpdate(prevDoc, Y.encodeStateAsUpdate(base))
      // Fragment client 1's Item(1,0,'ab',len=2) in prevDoc into 'a'(len=1) + 'X' + 'b'(len=1)
      prevDoc.get('text').insert(1, 'X')

      const nextDoc = new Y.Doc({ gc: true })
      nextDoc.clientID = 3
      Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(base))
      // Delete 'ab' as one contiguous ContentDeleted(len=2) in nextDoc
      nextDoc.get('text').delete(0, 2)

      const renderer = Y.createDiffRenderer(prevDoc, nextDoc)
      try {
        renderer.rejectChanges(Y.createID(1, 0), Y.createID(1, 0))
        verifyDocInvariants(nextDoc, { expectNoPending: true, label: 'R-3:nextDoc' })
        verifyDocInvariants(prevDoc, { expectNoPending: true, label: 'R-3:prevDoc' })
        assertInvariant(
          nextDoc.get('text').toString() === 'ab',
          `R-3: rejecting deletion of "ab" lost content (got "${nextDoc.get('text').toString()}", expected "ab")`
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
    id: 'P-1',
    title: 'mapItemGet & applyDelta modifyAttr ignore rendererMode===2 on past-state AttributionsRenderer',
    targetPr: 'PR #5',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      const ymap = doc.get('map')
      const pastChild = new Y.Node()
      pastChild.insert(0, 'old')
      ymap.setAttr('child', pastChild)
      ymap.setAttr('k0', 'initial')

      // Capture frozen past-state renderer BEFORE future writes
      const pastCids = Y.createContentIdsFromDoc(doc, false)
      const pastRenderer = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: pastCids.inserts })

      // Future writes (all have rendererMode === 2, completely invisible under pastRenderer)
      ymap.setAttr('futureOnly', 'secret')
      const futureNode = new Y.Node()
      futureNode.insert(0, 'future')
      ymap.setAttr('futureNode', futureNode)
      const futureChild = new Y.Node()
      futureChild.insert(0, 'new')
      ymap.setAttr('child', futureChild)

      try {
        // 1. position-helpers mapItemGet must return null for keys ignored by pastRenderer (rendererMode===2)
        const [rposFutureOnly, rposFutureNode, rposChild] = Y.createRelativePositionsFromDeltaPositions(
          ymap,
          [
            dpos.create(['futureOnly'], 1),
            dpos.create(['futureNode', 0], 1),
            dpos.create(['child', 0], 1)
          ],
          { renderer: pastRenderer }
        )
        assertInvariant(
          rposFutureOnly === null,
          'P-1: mapItemGet resolved a RelativePosition for key "futureOnly" ignored by pastRenderer (mode===2)'
        )
        assertInvariant(
          rposFutureNode === null,
          'P-1: mapItemGet descended into "futureNode" ignored by pastRenderer (mode===2)'
        )
        const futureChildStart = futureChild._start
        if (rposChild !== null && futureChildStart !== null) {
          assertInvariant(
            !Y.compareIDs(rposChild.item, futureChildStart.id),
            'P-1: mapItemGet resolved overwritten key "child" to ignored futureChild instead of rendered pastChild'
          )
        }

        // 2. applyDelta modifyAttr must NOT mutate a map child ignored by pastRenderer (rendererMode===2)
        try {
          ymap.applyDelta(
            delta.create(delta.$deltaAny).modifyAttr('futureNode', delta.create(delta.$deltaAny).insert('X').done()).done(),
            null,
            { renderer: pastRenderer }
          )
        } catch (_err) {
          // Rejecting modifyAttr on an unrendered key is valid; silent mutation is not
        }
        assertInvariant(
          futureNode.toString() === 'future',
          `P-1: applyDelta modifyAttr under pastRenderer mutated invisible futureNode to "${futureNode.toString()}"`
        )
      } finally {
        pastRenderer.destroy()
        doc.destroy()
      }
    }
  },
  {
    id: 'P-3',
    title: 'createRelativePositionsFromDeltaPositions calls root.get(step0), polluting doc.share with empty YNodes for nonexistent roots',
    targetPr: 'PR #5',
    run: () => {
      const doc = new Y.Doc()
      try {
        doc.get('text').insert(0, 'hi')
        assertInvariant(doc.share.size === 1, 'P-3: expected initial doc.share.size === 1')
        const [rpos] = Y.createRelativePositionsFromDeltaPositions(
          doc,
          [dpos.create(['nonexistent_root', 0], 1)]
        )
        assertInvariant(
          !doc.share.has('nonexistent_root') && doc.share.size === 1,
          `P-3: createRelativePositionsFromDeltaPositions polluted doc.share (size=${doc.share.size}, has('nonexistent_root')=${doc.share.has('nonexistent_root')})`
        )
        assertInvariant(
          rpos === null,
          'P-3: expected null RelativePosition for nonexistent root key'
        )
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-ATTR-STALE-INSERT',
    title: 'Deleting an attributed item under AttributionsRenderer leaves stale insert attribution in live .delta cache',
    targetPr: 'PR #5',
    run: () => {
      // Case A: ContentString with insert attribution deleted under AttributionsRenderer
      const docA = new Y.Doc({ gc: false })
      docA.clientID = 1
      const textA = docA.get('text')
      textA.insert(0, 'hello')
      const cmapA = Y.createContentMap()
      cmapA.inserts.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      const rendA = Y.createAttributionsRenderer(cmapA)
      textA.useRenderer(rendA)
      const liveA = textA.delta

      // Case B: ContentAny array with insert attribution on leading element deleted under AttributionsRenderer
      const docB = new Y.Doc({ gc: false })
      docB.clientID = 2
      const arrB = docB.get('array')
      arrB.insert(0, [10, 20, 30, 40])
      const cmapB = Y.createContentMap()
      cmapB.inserts.add(2, 0, 1, [Y.createContentAttribute('insert', 'bob')])
      const rendB = Y.createAttributionsRenderer(cmapB)
      arrB.useRenderer(rendB)
      const liveB = arrB.delta

      // Case C: cmap.deletes-only attribution (empty insert:[] while alive, delete:['carol'] once deleted)
      const docC = new Y.Doc({ gc: false })
      docC.clientID = 3
      const textC = docC.get('text')
      textC.insert(0, 'abc')
      const cmapC = Y.createContentMap()
      cmapC.deletes.add(3, 0, 3, [Y.createContentAttribute('delete', 'carol')])
      const rendC = Y.createAttributionsRenderer(cmapC)
      textC.useRenderer(rendC)
      const liveC = textC.delta

      try {
        textA.delete(0, 5)
        const freshA = textA.toDeltaDeep()
        assertInvariant(
          liveA.equals(freshA),
          `BUG-ATTR-STALE-INSERT(A): ContentString live .delta retained stale insert attribution!\n  live:  ${JSON.stringify(liveA.toJSON())}\n  fresh: ${JSON.stringify(freshA.toJSON())}`
        )

        arrB.delete(0, 3)
        const freshB = arrB.toDeltaDeep()
        assertInvariant(
          liveB.equals(freshB),
          `BUG-ATTR-STALE-INSERT(B): ContentAny live .delta retained stale insert attribution!\n  live:  ${JSON.stringify(liveB.toJSON())}\n  fresh: ${JSON.stringify(freshB.toJSON())}`
        )

        textC.delete(0, 3)
        const freshC = textC.toDeltaDeep()
        assertInvariant(
          liveC.equals(freshC),
          `BUG-ATTR-STALE-INSERT(C): deletes-only live .delta retained stale empty insert:[] attribution!\n  live:  ${JSON.stringify(liveC.toJSON())}\n  fresh: ${JSON.stringify(freshC.toJSON())}`
        )
      } finally {
        rendA.destroy()
        rendB.destroy()
        rendC.destroy()
        docA.destroy()
        docB.destroy()
        docC.destroy()
      }
    }
  },
  {
    id: 'BUG-LAMPORT-CAUSALITY',
    title: 'V1 update with impossible same-client future/self origin reference must be rejected atomically without corrupting doc',
    targetPr: 'PR #2',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      doc.get('text').insert(0, 'seed')
      doc.get('map').setAttr('k1', 'orig')

      const beforeV1 = Y.encodeStateAsUpdate(doc)
      const beforeSV = Y.encodeStateVector(doc)

      // Payload 1: Client 10 Item(10,0,len=2,origin=ID(10,2)) referencing future map Item(10,2,parent='map',parentSub='k1')
      const encFutureOrigin = encoding.createEncoder()
      encoding.writeVarUint(encFutureOrigin, 1) // 1 client
      encoding.writeVarUint(encFutureOrigin, 2) // 2 structs
      encoding.writeVarUint(encFutureOrigin, 10) // client=10
      encoding.writeVarUint(encFutureOrigin, 0) // start clock=0
      // Struct 1: Item(10,0,len=2,origin=ID(10,2),ContentString('ab'))
      encoding.writeUint8(encFutureOrigin, 4 | 0x80)
      encoding.writeVarUint(encFutureOrigin, 10)
      encoding.writeVarUint(encFutureOrigin, 2)
      encoding.writeVarString(encFutureOrigin, 'ab')
      // Struct 2: Item(10,2,len=1,parent='map',parentSub='k1',ContentAny(['val']))
      encoding.writeUint8(encFutureOrigin, 8 | 0x20)
      encoding.writeVarUint(encFutureOrigin, 1) // parentInfo = ykey string
      encoding.writeVarString(encFutureOrigin, 'map')
      encoding.writeVarString(encFutureOrigin, 'k1')
      encoding.writeVarUint(encFutureOrigin, 1) // ContentAny len=1
      encoding.writeAny(encFutureOrigin, 'val')
      encoding.writeVarUint(encFutureOrigin, 0) // empty deleteSet
      const payloadFutureOrigin = encoding.toUint8Array(encFutureOrigin)

      // Payload 2: Client 11 self-referencing origin Item(11,0,len=1,origin=ID(11,0))
      const encSelfOrigin = encoding.createEncoder()
      encoding.writeVarUint(encSelfOrigin, 1)
      encoding.writeVarUint(encSelfOrigin, 1)
      encoding.writeVarUint(encSelfOrigin, 11)
      encoding.writeVarUint(encSelfOrigin, 0)
      encoding.writeUint8(encSelfOrigin, 4 | 0x80)
      encoding.writeVarUint(encSelfOrigin, 11)
      encoding.writeVarUint(encSelfOrigin, 0)
      encoding.writeVarString(encSelfOrigin, 'x')
      encoding.writeVarUint(encSelfOrigin, 0)
      const payloadSelfOrigin = encoding.toUint8Array(encSelfOrigin)

      // Payload 3: Client 12 future rightOrigin Item(12,0,len=1,rightOrigin=ID(12,1)) -> Item(12,1,parent='text')
      const encFutureRight = encoding.createEncoder()
      encoding.writeVarUint(encFutureRight, 1)
      encoding.writeVarUint(encFutureRight, 2)
      encoding.writeVarUint(encFutureRight, 12)
      encoding.writeVarUint(encFutureRight, 0)
      encoding.writeUint8(encFutureRight, 4 | 0x40) // BIT7 = hasRightOrigin
      encoding.writeVarUint(encFutureRight, 12)
      encoding.writeVarUint(encFutureRight, 1)
      encoding.writeVarString(encFutureRight, 'a')
      encoding.writeUint8(encFutureRight, 4) // origin=null, rightOrigin=null, parent='text'
      encoding.writeVarUint(encFutureRight, 1)
      encoding.writeVarString(encFutureRight, 'text')
      encoding.writeVarString(encFutureRight, 'b')
      encoding.writeVarUint(encFutureRight, 0)
      const payloadFutureRight = encoding.toUint8Array(encFutureRight)

      /** @type {Array<{ name: string, payload: Uint8Array }>} */
      const cases = [
        { name: 'same-client-future-origin-map', payload: payloadFutureOrigin },
        { name: 'same-client-self-origin', payload: payloadSelfOrigin },
        { name: 'same-client-future-rightOrigin', payload: payloadFutureRight }
      ]

      try {
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i]
          let threw = false
          try {
            Y.applyUpdate(doc, c.payload)
          } catch (_err) {
            threw = true
          }
          assertInvariant(
            threw,
            `BUG-LAMPORT-CAUSALITY(${c.name}): applyUpdate accepted impossible same-client forward/self causal reference without throwing!`
          )
          assertInvariant(
            equalBytes(Y.encodeStateAsUpdate(doc), beforeV1) && equalBytes(Y.encodeStateVector(doc), beforeSV),
            `BUG-LAMPORT-CAUSALITY(${c.name}): rejected update mutated doc state (atomicity violation)!`
          )
          verifyDocInvariants(doc, { expectNoPending: true, label: `BUG-LAMPORT-CAUSALITY:${c.name}` })
        }
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-RT-1',
    title: 'insertContent mutates caller op.format in place, corrupting finalized Delta & throwing TypeError on frozen format objects',
    targetPr: 'PR #5',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      const ytext = doc.get('text')
      try {
        ytext.insert(0, 'ab', { bold: true })

        // 1. Applying a finalized (.done()) Delta inside a formatted run must NOT mutate its op.format in place
        const d = delta.create().retain(1).insert('X', { italic: true }).done()
        const beforeJson = JSON.stringify(d.toJSON())
        const expected = delta.create().retain(1).insert('X', { italic: true }).done()
        ytext.applyDelta(d)
        const afterJson = JSON.stringify(d.toJSON())
        assertInvariant(
          afterJson === beforeJson && d.equals(expected),
          `BUG-RT-1: applyDelta mutated caller's .done() Delta in place!\n  before: ${beforeJson}\n  after:  ${afterJson}`
        )

        // 2. Passing a frozen format object to insert() inside a formatted run must NOT throw TypeError
        const frozenFmt = Object.freeze({ underline: true })
        /** @type {unknown} */
        let threwErr = null
        try {
          ytext.insert(1, 'Y', frozenFmt)
        } catch (err) {
          threwErr = err
        }
        assertInvariant(
          threwErr === null,
          `BUG-RT-1: ytext.insert() threw on Object.freeze({ underline: true }): ${String(threwErr)}`
        )
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-RT-2',
    title: 'cleanupYTextFormatting passes live countable start into cleanupFormattingGap, skipping every gap after char 0',
    targetPr: 'PR #5',
    run: () => {
      /**
       * Count alive ContentFormat items in a YNode's linked list.
       *
       * @param {Y.Node} node
       * @return {number}
       */
      const countAliveFormats = node => {
        let count = 0
        for (let item = node._start; item !== null; item = item.right) {
          if (!item.deleted && item.content instanceof Y.ContentFormat) {
            count++
          }
        }
        return count
      }

      const d1 = new Y.Doc({ gc: false })
      const d2 = new Y.Doc({ gc: false })
      const d3 = new Y.Doc({ gc: false, isSuggestionDoc: true })
      d1.clientID = 1
      d2.clientID = 2
      d3.clientID = 3
      try {
        d1.get('text').insert(0, 'abc')
        const baseU = Y.encodeStateAsUpdate(d1)
        Y.applyUpdate(d2, baseU)
        Y.applyUpdate(d3, baseU)

        // Concurrent identical bold formatting on char index 1 ('b') creates duplicate ContentFormat markers after 'a' and 'b'
        d1.get('text').format(1, 1, { bold: true })
        d2.get('text').format(1, 1, { bold: true })
        const u1 = Y.encodeStateAsUpdate(d1)
        const u2 = Y.encodeStateAsUpdate(d2)

        // 1. Automatic cleanup during sync on d1 must remove the 2 redundant markers (4 -> 2)
        Y.applyUpdate(d1, u2)
        const aliveD1 = countAliveFormats(d1.get('text'))
        assertInvariant(
          aliveD1 === 2,
          `BUG-RT-2: automatic formatting cleanup after sync left ${aliveD1} alive ContentFormat items (expected 2)`
        )

        // 2. Direct cleanupYTextFormatting call on d3 (which deferred cleanup during sync) must clean 2 redundant markers
        Y.applyUpdate(d3, u1)
        Y.applyUpdate(d3, u2)
        const aliveBefore = countAliveFormats(d3.get('text'))
        assertInvariant(aliveBefore === 4, `BUG-RT-2: expected 4 duplicate markers before manual cleanup, got ${aliveBefore}`)
        d3.cleanupFormatting = true
        const cleaned = Y.cleanupYTextFormatting(d3.get('text'))
        const aliveAfter = countAliveFormats(d3.get('text'))
        assertInvariant(
          cleaned === 2 && aliveAfter === 2,
          `BUG-RT-2: cleanupYTextFormatting cleaned ${cleaned} markers and left ${aliveAfter} alive (expected cleaned=2, alive=2)`
        )
      } finally {
        d1.destroy()
        d2.destroy()
        d3.destroy()
      }
    }
  },
  {
    id: 'BUG-RT-3',
    title: 'cleanupFormattingGap compares format values with === instead of equalFormats, leaking redundant object-mark ContentFormat items',
    targetPr: 'PR #5',
    run: () => {
      const doc = new Y.Doc({ gc: false })
      doc.clientID = 1
      const ytext = doc.get('text')
      try {
        ytext.insert(0, 'a', { link: { href: 'https://yjs.dev' } })
        ytext.insert(1, 'b')
        ytext.insert(2, 'c', { link: { href: 'https://yjs.dev' } })
        // Deleting 'b' makes 'a' and 'c' adjacent with structurally identical object-valued link marks
        ytext.delete(1, 1)

        let aliveFormats = 0
        for (let item = ytext._start; item !== null; item = item.right) {
          if (!item.deleted && item.content instanceof Y.ContentFormat) {
            aliveFormats++
          }
        }
        assertInvariant(
          aliveFormats === 2,
          `BUG-RT-3: deleting 'b' between identical object-valued { link: { href } } runs left ${aliveFormats} alive ContentFormat items (expected 2)`
        )
      } finally {
        doc.destroy()
      }
    }
  },
  {
    id: 'BUG-828-SAFETY',
    title: 'Concurrent identical format + anchored insert (#828) must remain commutative and preserve bold on inserted char Z',
    targetPr: 'PR #5',
    run: () => {
      const expected = delta.create().insert('a').insert('Zb', { bold: true }).done()

      // Order 1: A1 -> B first (triggers cleanupYTextAfterTransaction on B), then A2 -> B, then B <-> A
      const a1 = new Y.Doc({ gc: false })
      const b1 = new Y.Doc({ gc: false })
      a1.clientID = 1
      b1.clientID = 2

      // Order 2: B1 -> A first, then A <-> B
      const a2 = new Y.Doc({ gc: false })
      const b2 = new Y.Doc({ gc: false })
      a2.clientID = 1
      b2.clientID = 2

      try {
        // Shared base 'ab' on both pairs
        a1.get('text').insert(0, 'ab')
        const baseU = Y.encodeStateAsUpdate(a1)
        Y.applyUpdate(b1, baseU)
        Y.applyUpdate(a2, baseU)
        Y.applyUpdate(b2, baseU)

        // Pair 1 offline ops
        const svA1Base = Y.encodeStateVector(a1)
        a1.get('text').format(1, 1, { bold: true }) // Tx A1: creates CF_A1(bold:true) before 'b'
        const uA1 = Y.encodeStateAsUpdate(a1, svA1Base)
        const svA1After = Y.encodeStateVector(a1)
        a1.get('text').insert(1, 'Z', { bold: true }) // Tx A2: anchors 'Z' at origin = CF_A1
        const uA2 = Y.encodeStateAsUpdate(a1, svA1After)

        b1.get('text').format(1, 1, { bold: true }) // Tx B1: concurrent identical bold on 'b'

        // Deliver A1 -> B1 first, then A2 -> B1, then full sync
        Y.applyUpdate(b1, uA1)
        Y.applyUpdate(b1, uA2)
        Y.applyUpdate(a1, Y.encodeStateAsUpdate(b1, Y.encodeStateVector(a1)))
        Y.applyUpdate(b1, Y.encodeStateAsUpdate(a1, Y.encodeStateVector(b1)))

        // Pair 2 identical offline ops, reverse delivery order (B1 -> A2 first)
        const svB2Base = Y.encodeStateVector(b2)
        b2.get('text').format(1, 1, { bold: true }) // Tx B1
        const uB2 = Y.encodeStateAsUpdate(b2, svB2Base)
        a2.get('text').format(1, 1, { bold: true }) // Tx A1
        a2.get('text').insert(1, 'Z', { bold: true }) // Tx A2

        Y.applyUpdate(a2, uB2)
        Y.applyUpdate(b2, Y.encodeStateAsUpdate(a2, Y.encodeStateVector(b2)))
        Y.applyUpdate(a2, Y.encodeStateAsUpdate(b2, Y.encodeStateVector(a2)))

        const dA1 = a1.get('text').toDeltaDeep()
        const dB1 = b1.get('text').toDeltaDeep()
        const dA2 = a2.get('text').toDeltaDeep()
        const dB2 = b2.get('text').toDeltaDeep()

        assertInvariant(
          dA1.equals(expected) && dB1.equals(expected),
          `BUG-828-SAFETY(Order1): Z lost bold formatting!\n  A1: ${JSON.stringify(dA1.toJSON())}\n  B1: ${JSON.stringify(dB1.toJSON())}\n  exp:${JSON.stringify(expected.toJSON())}`
        )
        assertInvariant(
          dA2.equals(expected) && dB2.equals(expected),
          `BUG-828-SAFETY(Order2): reverse delivery order diverged!\n  A2: ${JSON.stringify(dA2.toJSON())}\n  B2: ${JSON.stringify(dB2.toJSON())}`
        )
        assertInvariant(
          dA1.equals(dA2) && dB1.equals(dB2),
          'BUG-828-SAFETY: Order 1 and Order 2 failed to commute identically!'
        )
      } finally {
        a1.destroy()
        b1.destroy()
        a2.destroy()
        b2.destroy()
      }
    }
  },
  {
    id: 'BUG-SKIP-WRITE',
    title: 'Skip.prototype.write ignores offsetEnd, shifting subsequent struct clocks when slicing a Skip',
    targetPr: 'PR #5',
    run: () => {
      const src = new Y.Doc({ gc: false })
      const partial = new Y.Doc({ gc: false })
      src.clientID = 1
      try {
        // Build Item(1, 0, len=1), clocks 1..10 gap, Item(1, 11, len=1) with origin=null so it integrates ahead of gap
        src.get('text').insert(0, 'a')
        const u0 = Y.encodeStateAsUpdate(src)
        src.get('text').insert(1, '0123456789')
        const sv11 = Y.encodeStateVector(src)
        src.get('other').insert(0, 'z')
        const u11 = Y.encodeStateAsUpdate(src, sv11)

        // partial.store now holds [Item(1,0,1), Skip(1,1,10), Item(1,11,1)]
        Y.applyUpdate(partial, u0)
        Y.applyUpdate(partial, u11)
        const partialV1 = Y.encodeStateAsUpdate(partial)
        const partialV2 = Y.encodeStateAsUpdateV2(partial)

        // Slice [0, 5) U [11, 12) -> hits Skip(1,1,10) with offset=0, offsetEnd=6 in writeStructs (encoding-helpers.js:65)!
        const inserts = Y.createIdSet()
        inserts.add(1, 0, 5)
        inserts.add(1, 11, 1)

        // 1. Direct writeStructsFromIdSet V1 & V2 (exercises Skip.prototype.write with offsetEnd=6 directly)
        const encV1 = new Y.UpdateEncoderV1()
        writeStructsFromIdSet(encV1, partial.store, inserts)
        Y.writeIdSet(encV1, Y.createIdSet())
        const rawV1 = encV1.toUint8Array()
        const rawItemsV1 = Y.decodeUpdate(rawV1).structs.filter(s => s instanceof Y.Item && s.id.client === 1)
        assertInvariant(
          rawItemsV1.length === 2 && rawItemsV1[1].id.clock === 11,
          `BUG-SKIP-WRITE(writeStructs V1): second Item clock corrupted to ${rawItemsV1.length >= 2 ? String(rawItemsV1[1].id.clock) : 'missing'} (expected 11)`
        )

        const encV2 = new Y.UpdateEncoderV2()
        writeStructsFromIdSet(encV2, partial.store, inserts)
        Y.writeIdSet(encV2, Y.createIdSet())
        const rawV2 = encV2.toUint8Array()
        const rawItemsV2 = Y.decodeUpdateV2(rawV2).structs.filter(s => s instanceof Y.Item && s.id.client === 1)
        assertInvariant(
          rawItemsV2.length === 2 && rawItemsV2[1].id.clock === 11,
          `BUG-SKIP-WRITE(writeStructs V2): second Item clock corrupted to ${rawItemsV2.length >= 2 ? String(rawItemsV2[1].id.clock) : 'missing'} (expected 11)`
        )

        // 2. Also confirm intersectUpdateWithContentIds V1 & V2 preserve exact Item clocks
        const cids = Y.createContentIds(inserts, Y.createIdSet())
        const itemsV1 = Y.decodeUpdate(Y.intersectUpdateWithContentIds(partialV1, cids)).structs.filter(s => s instanceof Y.Item && s.id.client === 1)
        const itemsV2 = Y.decodeUpdateV2(Y.intersectUpdateWithContentIdsV2(partialV2, cids)).structs.filter(s => s instanceof Y.Item && s.id.client === 1)
        assertInvariant(
          itemsV1.length === 2 && itemsV1[1].id.clock === 11,
          `BUG-SKIP-WRITE(intersect V1): second Item clock corrupted to ${itemsV1.length >= 2 ? String(itemsV1[1].id.clock) : 'missing'} (expected 11)`
        )
        assertInvariant(
          itemsV2.length === 2 && itemsV2[1].id.clock === 11,
          `BUG-SKIP-WRITE(intersect V2): second Item clock corrupted to ${itemsV2.length >= 2 ? String(itemsV2[1].id.clock) : 'missing'} (expected 11)`
        )
      } finally {
        src.destroy()
        partial.destroy()
      }
    }
  },
  {
    id: 'BUG-SV-SKIP0',
    title: 'encodeStateVectorFromUpdate(V1/V2) hallucinates clock=len when first client starts with Skip(client, 0, len)',
    targetPr: 'PR #5',
    run: () => {
      const src = new Y.Doc({ gc: false })
      const partial = new Y.Doc({ gc: false })
      src.clientID = 7
      try {
        src.get('text').insert(0, '01234') // clocks 0..5
        const sv5 = Y.encodeStateVector(src)
        src.get('other').insert(0, 'hi') // clocks 5..7, origin=null -> integrates with Skip(7, 0, 5)
        const uTail = Y.encodeStateAsUpdate(src, sv5)

        Y.applyUpdate(partial, uTail)
        const trueSv = Y.decodeStateVector(Y.encodeStateVector(partial))
        assertInvariant((trueSv.get(7) ?? 0) === 0, `BUG-SV-SKIP0: setup expected true SV(7)=0, got ${String(trueSv.get(7))}`)

        const uV1 = Y.encodeStateAsUpdate(partial)
        const uV2 = Y.encodeStateAsUpdateV2(partial)
        const svFromV1 = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(uV1))
        const svFromV2 = Y.decodeStateVector(Y.encodeStateVectorFromUpdateV2(uV2))

        assertInvariant(
          (svFromV1.get(7) ?? 0) === 0,
          `BUG-SV-SKIP0(V1): encodeStateVectorFromUpdate hallucinated client 7 clock=${String(svFromV1.get(7))} (expected 0)`
        )
        assertInvariant(
          (svFromV2.get(7) ?? 0) === 0,
          `BUG-SV-SKIP0(V2): encodeStateVectorFromUpdateV2 hallucinated client 7 clock=${String(svFromV2.get(7))} (expected 0)`
        )
      } finally {
        src.destroy()
        partial.destroy()
      }
    }
  },
  {
    id: 'BUG-BLOCKSET-LEADSKIP',
    title: 'BlockSet.insertInto slow path emits spurious leading Skip(client, 0, ...) when result is empty',
    targetPr: 'PR #5',
    run: () => {
      const src = new Y.Doc({ gc: false })
      const docA = new Y.Doc({ gc: false })
      const docB = new Y.Doc({ gc: false })
      src.clientID = 7
      try {
        src.get('t0').insert(0, '012') // clocks 0..3
        const sv3 = Y.encodeStateVector(src)
        src.get('t1').insert(0, 'ab') // clocks 3..5
        const tailA = Y.encodeStateAsUpdate(src, sv3)
        const sv5 = Y.encodeStateVector(src)
        src.get('t2').insert(0, 'cd') // clocks 5..7
        const tailB = Y.encodeStateAsUpdate(src, sv5)

        // docA -> [Skip(7,0,3), Item(7,3,2)], docB -> [Skip(7,0,5), Item(7,5,2)]
        Y.applyUpdate(docA, tailA)
        Y.applyUpdate(docB, tailB)

        const uAv1 = Y.encodeStateAsUpdate(docA)
        const uBv1 = Y.encodeStateAsUpdate(docB)
        const uAv2 = Y.encodeStateAsUpdateV2(docA)
        const uBv2 = Y.encodeStateAsUpdateV2(docB)

        // Both orders hit BlockSet.insertInto slow path: [uA, uB] hits L302, [uB, uA] hits L285
        const mergedV1Cases = [
          { name: 'V1(A,B)', u: Y.mergeUpdates([uAv1, uBv1]) },
          { name: 'V1(B,A)', u: Y.mergeUpdates([uBv1, uAv1]) }
        ]
        for (let i = 0; i < mergedV1Cases.length; i++) {
          const c = mergedV1Cases[i]
          const dec = Y.decodeUpdate(c.u)
          assertInvariant(
            dec.structs.length > 0 && !(dec.structs[0] instanceof Y.Skip) && dec.structs[0].id.clock === 3,
            `BUG-BLOCKSET-LEADSKIP(${c.name}): first struct was ${dec.structs[0] ? `${dec.structs[0].constructor.name}@${dec.structs[0].id.clock}` : 'none'} (expected Item@3, no leading Skip)`
          )
          const sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(c.u))
          assertInvariant(
            (sv.get(7) ?? 0) === 0,
            `BUG-BLOCKSET-LEADSKIP(${c.name}): encodeStateVectorFromUpdate reported client 7 clock=${String(sv.get(7))} (expected 0)`
          )
        }

        const mergedV2Cases = [
          { name: 'V2(A,B)', u: Y.mergeUpdatesV2([uAv2, uBv2]) },
          { name: 'V2(B,A)', u: Y.mergeUpdatesV2([uBv2, uAv2]) }
        ]
        for (let i = 0; i < mergedV2Cases.length; i++) {
          const c = mergedV2Cases[i]
          const dec = Y.decodeUpdateV2(c.u)
          assertInvariant(
            dec.structs.length > 0 && !(dec.structs[0] instanceof Y.Skip) && dec.structs[0].id.clock === 3,
            `BUG-BLOCKSET-LEADSKIP(${c.name}): first struct was ${dec.structs[0] ? `${dec.structs[0].constructor.name}@${dec.structs[0].id.clock}` : 'none'} (expected Item@3, no leading Skip)`
          )
          const sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdateV2(c.u))
          assertInvariant(
            (sv.get(7) ?? 0) === 0,
            `BUG-BLOCKSET-LEADSKIP(${c.name}): encodeStateVectorFromUpdateV2 reported client 7 clock=${String(sv.get(7))} (expected 0)`
          )
        }
      } finally {
        src.destroy()
        docA.destroy()
        docB.destroy()
      }
    }
  },
  {
    id: 'ID-COPY-2',
    title: 'mergeIdSets & diffIdSet alias input IdRange with _lastIsUsed=false so subsequent .add() silently mutates inputs',
    targetPr: 'PR #5',
    run: () => {
      // Part A: mergeIdSets([a]) + m.add(1, 5, 3) must NOT mutate input a from [0,5) to [0,8)
      const a = Y.createIdSet()
      a.add(1, 0, 5)
      const m = Y.mergeIdSets([a])
      m.add(1, 5, 3)
      assertInvariant(
        !a.has(1, 5) && !a.has(1, 7),
        `ID-COPY-2(mergeIdSets): m.add(1, 5, 3) silently mutated input IdSet a (a.has(1,5)=${a.has(1, 5)}, a.has(1,7)=${a.has(1, 7)})`
      )

      // Part B: diffIdSet(a2, empty) + d.add(1, 5, 3) must NOT mutate input a2 from [0,5) to [0,8)
      const a2 = Y.createIdSet()
      a2.add(1, 0, 5)
      const d = Y.diffIdSet(a2, Y.createIdSet())
      d.add(1, 5, 3)
      assertInvariant(
        !a2.has(1, 5) && !a2.has(1, 7),
        `ID-COPY-2(diffIdSet): d.add(1, 5, 3) silently mutated input IdSet a2 (a2.has(1,5)=${a2.has(1, 5)}, a2.has(1,7)=${a2.has(1, 7)})`
      )
    }
  },
  {
    id: 'BUG-IDMAP-INSERT',
    title: 'insertIntoIdMap installs IdRanges from IdSet (erasing later attrs) and skips _ensureAttrs (duplicating equal attrs)',
    targetPr: 'PR #5',
    run: () => {
      // Part A: insertIntoIdMap(dest, idSet) installs IdRanges instead of AttrRanges, silently dropping later attrs
      const dest = Y.createIdMap()
      const idSet = Y.createIdSet()
      idSet.add(1, 0, 5)
      Y.insertIntoIdMap(dest, idSet)
      dest.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      const slicedA = dest.slice(1, 0, 5)
      const hasAlice = slicedA.length > 0 && slicedA.every(r => r.attrs !== null && r.attrs.some(a => a.name === 'insert' && a.val === 'alice'))
      assertInvariant(
        hasAlice,
        `BUG-IDMAP-INSERT(A1): insertIntoIdMap(dest, idSet) installed IdRanges causing dest.add() to silently erase 'alice' (slice=${JSON.stringify(slicedA)})`
      )
      const dest2 = Y.createIdMap()
      Y.insertIntoIdMap(dest2, idSet)
      const otherMap = Y.createIdMap()
      otherMap.add(1, 0, 5, [Y.createContentAttribute('insert', 'bob')])
      Y.insertIntoIdMap(dest2, otherMap)
      const slicedA2 = dest2.slice(1, 0, 5)
      const hasBob = slicedA2.length > 0 && slicedA2.every(r => r.attrs !== null && r.attrs.some(a => a.name === 'insert' && a.val === 'bob'))
      assertInvariant(
        hasBob,
        `BUG-IDMAP-INSERT(A2): insertIntoIdMap(dest2, idSet) followed by insertIntoIdMap(dest2, otherMap) silently erased 'bob' (slice=${JSON.stringify(slicedA2)})`
      )

      // Part B: insertIntoIdMap(mapA, mapB) skips _ensureAttrs, duplicating equal-value ContentAttribute instances
      const mapA = Y.createIdMap()
      mapA.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      const mapB = Y.createIdMap()
      mapB.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      Y.insertIntoIdMap(mapA, mapB)
      const rangesB = mapA.clients.get(1)?.getIds() ?? []
      assertInvariant(
        rangesB.length === 1 && rangesB[0].attrs.length === 1,
        `BUG-IDMAP-INSERT(B): insertIntoIdMap(mapA, mapB) accumulated duplicate equal attrs (attrs.length=${rangesB[0] ? rangesB[0].attrs.length : 0}, expected 1)`
      )
      assertInvariant(
        mapA.attrs.size === 1,
        `BUG-IDMAP-INSERT(B): expected mapA.attrs.size === 1, got ${mapA.attrs.size}`
      )
    }
  },
  {
    id: 'BUG-IDMAP-INTERSECT',
    title: 'intersectMaps duplicates equal attrs & leaves attrs.size=0; diffIdMap aliases src.attrs/attrsH',
    targetPr: 'PR #5',
    run: () => {
      // Part A: intersectMaps(a, b) with equal ContentAttributes duplicates attrs and leaves c.attrs empty
      const a = Y.createIdMap()
      a.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      const b = Y.createIdMap()
      b.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      const c = Y.intersectMaps(a, b)
      const ranges = c.clients.get(1)?.getIds() ?? []
      assertInvariant(
        ranges.length === 1 && ranges[0].attrs.length === 1,
        `BUG-IDMAP-INTERSECT(A): intersectMaps produced duplicate attrs (attrs.length=${ranges[0] ? ranges[0].attrs.length : 0}, expected 1)`
      )
      assertInvariant(
        c.attrs.size === 1,
        `BUG-IDMAP-INTERSECT(A): intersectMaps left c.attrs.size=${c.attrs.size} (expected 1)`
      )

      // Part B: diffIdMap(src, empty) directly aliases src.attrs & src.attrsH so mutating diffed mutates src
      const src = Y.createIdMap()
      src.add(1, 0, 5, [Y.createContentAttribute('insert', 'alice')])
      const diffed = Y.diffIdMap(src, Y.createIdSet())
      diffed.add(1, 0, 1, [Y.createContentAttribute('insert', 'bob')])
      assertInvariant(
        src.attrs.size === 1 && src.attrsH.size === 1,
        `BUG-IDMAP-INTERSECT(B): diffIdMap aliased src.attrs/attrsH — diffed.add() mutated src (attrs.size=${src.attrs.size}, attrsH.size=${src.attrsH.size}, expected 1)`
      )
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
