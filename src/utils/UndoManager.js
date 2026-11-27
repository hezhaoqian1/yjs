import * as time from 'lib0/time'
import * as array from 'lib0/array'
import * as logging from 'lib0/logging'
import * as math from 'lib0/math'
import { ObservableV2 } from 'lib0/observable'

import { mergeIdSets, iterateStructsByIdSet, diffIdSet } from './ids.js'
import { Item, ContentType } from '../structs/Item.js'

import { transact } from './Transaction.js'
import { createID } from './ID.js'
import { isParentOf } from './isParentOf.js'
import { getItemCleanStart } from './transaction-helpers.js'
import { Doc } from './Doc.js'
import { YNode, clearSearchMarkers } from '../ynode.js'

/**
 * Registry of active UndoManagers per Doc so clearing or destroying one stack/UndoManager
 * never strips `keep = true` from items or ancestors still needed by another stack or UndoManager.
 *
 * @type {WeakMap<Doc, Set<UndoManager>>}
 */
const docUndoManagers = new WeakMap()

export class StackItem {
  /**
   * @param {IdSet} insertions
   * @param {IdSet} deletions
   */
  constructor (insertions, deletions) {
    this.inserts = insertions
    this.deletes = deletions
    /**
     * Use this to save and restore metadata like selection range
     */
    this.meta = new Map()
  }
}

/**
 * @param {Transaction} tr
 * @param {UndoManager} um
 * @param {StackItem} stackItem
 * @param {boolean} keep
 */
const setStackItemKeep = (tr, um, stackItem, keep) => {
  iterateStructsByIdSet(tr, stackItem.deletes, item => {
    if (item instanceof Item && um.scope.some(type => type === tr.doc || isParentOf(/** @type {YNode} */ (type), item))) {
      keepItem(item, keep)
    }
  })
}

/**
 * @param {Transaction} tr
 * @param {UndoManager} um
 * @param {StackItem} stackItem
 */
const clearUndoManagerStackItem = (tr, um, stackItem) => {
  setStackItemKeep(tr, um, stackItem, false)
}

/**
 * Re-apply `keep = true` for every remaining stack item across all active UndoManagers on `doc`.
 *
 * @param {Transaction} tr
 * @param {Doc} doc
 */
const rekeepDocUndoManagers = (tr, doc) => {
  const ums = docUndoManagers.get(doc)
  if (ums !== undefined) {
    ums.forEach(um => {
      for (let i = 0; i < um.undoStack.length; i++) {
        setStackItemKeep(tr, um, um.undoStack[i], true)
      }
      for (let i = 0; i < um.redoStack.length; i++) {
        setStackItemKeep(tr, um, um.redoStack[i], true)
      }
    })
  }
}

/**
 * Follow a chain of `redone` pointers starting at `id` while clamping the covered span
 * against every hop's remaining length (so neither intermediate splits nor downstream merges
 * can widen the resolved range).
 *
 * @param {StructStore} store
 * @param {ID} id
 * @param {number} maxLen
 * @return {{ item: Item | GC | Skip, diff: number, len: number }}
 */
const followRedoneRange = (store, id, maxLen) => {
  /**
   * @type {ID|null}
   */
  let nextID = id
  let diff = 0
  let len = maxLen
  /**
   * @type {Item | GC | Skip}
   */
  let item
  do {
    if (diff > 0) {
      nextID = createID(nextID.client, nextID.clock + diff)
    }
    item = store.get(nextID)
    diff = nextID.clock - item.id.clock
    len = math.min(len, item.length - diff)
    nextID = item.isItem ? /** @type {Item} */ (item).redone : null
  } while (nextID !== null)
  return {
    item, diff, len
  }
}

/**
 * @param {Transaction} transaction
 * @param {ID} id
 * @return {Item|null}
 */
const getRedoneItem = (transaction, id) => {
  const store = transaction.doc.store
  if (id.clock >= store.getClock(id.client)) {
    return null
  }
  const struct = store.get(id)
  if (!struct.isItem) {
    return null
  }
  return getItemCleanStart(transaction, id)
}

/**
 * @param {UndoManager} undoManager
 * @param {Array<StackItem>} stack
 * @param {'undo'|'redo'} eventType
 * @return {StackItem?}
 */
const popStackItem = (undoManager, stack, eventType) => {
  /**
   * Keep a reference to the transaction so we can fire the event with the changedParentTypes
   * @type {any}
   */
  let _tr = null
  const doc = undoManager.doc
  const scope = undoManager.scope
  transact(doc, transaction => {
    while (stack.length > 0 && undoManager.currStackItem === null) {
      const store = doc.store
      const stackItem = /** @type {StackItem} */ (stack.pop())
      /**
       * @type {Set<Item>}
       */
      const itemsToRedo = new Set()
      /**
       * @type {Array<Item>}
       */
      const itemsToDelete = []
      let performedChange = false
      iterateStructsByIdSet(transaction, stackItem.inserts, struct => {
        if (struct instanceof Item) {
          if (struct.redone !== null) {
            const origClient = struct.id.client
            const origClock = struct.id.clock
            const origLen = struct.length
            let offset = 0
            while (offset < origLen) {
              const { item, diff, len } = followRedoneRange(store, createID(origClient, origClock + offset), origLen - offset)
              if (item.isItem && !item.deleted) {
                let target = /** @type {Item} */ (item)
                if (diff > 0) {
                  target = getItemCleanStart(transaction, createID(target.id.client, target.id.clock + diff))
                }
                if (len < target.length) {
                  getItemCleanStart(transaction, createID(target.id.client, target.id.clock + len))
                }
                if (scope.some(type => type === transaction.doc || isParentOf(/** @type {YNode} */ (type), target))) {
                  itemsToDelete.push(target)
                }
              }
              offset += len
            }
          } else if (!struct.deleted && scope.some(type => type === transaction.doc || isParentOf(/** @type {YNode} */ (type), struct))) {
            itemsToDelete.push(struct)
          }
        }
      })
      iterateStructsByIdSet(transaction, stackItem.deletes, struct => {
        if (
          struct instanceof Item &&
          scope.some(type => type === transaction.doc || isParentOf(/** @type {YNode} */ (type), struct)) &&
          // Never redo structs in stackItem.insertions because they were created and deleted in the same capture interval.
          !stackItem.inserts.hasId(struct.id)
        ) {
          itemsToRedo.add(struct)
        }
      })
      itemsToRedo.forEach(struct => {
        performedChange = redoItem(transaction, struct, itemsToRedo, stackItem.inserts, undoManager.ignoreRemoteAttributeChanges, undoManager) !== null || performedChange
      })
      // We want to delete in reverse order so that children are deleted before
      // parents, so we have more information available when items are filtered.
      for (let i = itemsToDelete.length - 1; i >= 0; i--) {
        const item = itemsToDelete[i]
        if (undoManager.deleteFilter(item)) {
          item.delete(transaction)
          performedChange = true
        }
      }
      clearUndoManagerStackItem(transaction, undoManager, stackItem)
      rekeepDocUndoManagers(transaction, doc)
      undoManager.currStackItem = performedChange ? stackItem : null
    }
    transaction.changed.forEach((subProps, type) => {
      // destroy search marker if necessary
      if (subProps.has(null) && type._searchMarker) {
        clearSearchMarkers(type._searchMarker)
      }
    })
    _tr = transaction
  }, undoManager)
  const res = undoManager.currStackItem
  if (res != null) {
    const changedParentTypes = _tr.changedParentTypes
    undoManager.emit('stack-item-popped', [{ stackItem: res, type: eventType, changedParentTypes, origin: undoManager }, undoManager])
    undoManager.currStackItem = null
  }
  return res
}

/**
 * @typedef {Object} UndoManagerOptions
 * @property {number} [UndoManagerOptions.captureTimeout=500]
 * @property {function(Transaction):boolean} [UndoManagerOptions.captureTransaction] Do not capture changes of a Transaction if result false.
 * @property {function(Item):boolean} [UndoManagerOptions.deleteFilter=()=>true] Sometimes
 * it is necessary to filter what an Undo/Redo operation can delete. If this
 * filter returns false, the type/item won't be deleted even it is in the
 * undo/redo scope.
 * @property {Set<any>} [UndoManagerOptions.trackedOrigins=new Set([null])]
 * @property {boolean} [ignoreRemoteAttributeChanges] By default, the UndoManager will never overwrite remote changes. In some cases this might be the expected behavior. This property enables overwriting remote changes on attribute changes. (previously named `ignoreRemoteMapChanges`)
 * @property {Doc} [doc] The document that this UndoManager operates on. Only needed if typeScope is empty.
 */

/**
 * @typedef {Object} StackItemEvent
 * @property {StackItem} StackItemEvent.stackItem
 * @property {any} StackItemEvent.origin
 * @property {'undo'|'redo'} StackItemEvent.type
 * @property {Map<YNode,Array<YEvent<any>>>} StackItemEvent.changedParentTypes
 */

/**
 * Fires 'stack-item-added' event when a stack item was added to either the undo- or
 * the redo-stack. You may store additional stack information via the
 * metadata property on `event.stackItem.meta` (it is a `Map` of metadata properties).
 * Fires 'stack-item-popped' event when a stack item was popped from either the
 * undo- or the redo-stack. You may restore the saved stack information from `event.stackItem.meta`.
 *
 * @extends {ObservableV2<{'stack-item-added':function(StackItemEvent, UndoManager):void, 'stack-item-popped': function(StackItemEvent, UndoManager):void, 'stack-cleared': function({ undoStackCleared: boolean, redoStackCleared: boolean }):void, 'stack-item-updated': function(StackItemEvent, UndoManager):void }>}
 */
export class UndoManager extends ObservableV2 {
  /**
   * @param {Doc|YNode|Array<YNode>} typeScope Limits the scope of the UndoManager. If this is set to a ydoc instance, all changes on that ydoc will be undone. If set to a specific type, only changes on that type or its children will be undone. Also accepts an array of types.
   * @param {UndoManagerOptions} options
   */
  constructor (typeScope, {
    captureTimeout = 500,
    captureTransaction = _tr => true,
    deleteFilter = () => true,
    trackedOrigins = new Set([null]),
    ignoreRemoteAttributeChanges = false,
    doc = /** @type {Doc} */ (array.isArray(typeScope) ? typeScope[0].doc : typeScope instanceof Doc ? typeScope : typeScope.doc)
  } = {}) {
    super()
    /**
     * @type {Array<YNode | Doc>}
     */
    this.scope = []
    this.doc = doc
    this.addToScope(typeScope)
    this.deleteFilter = deleteFilter
    trackedOrigins.add(this)
    this.trackedOrigins = trackedOrigins
    this.captureTransaction = captureTransaction
    /**
     * @type {Array<StackItem>}
     */
    this.undoStack = []
    /**
     * @type {Array<StackItem>}
     */
    this.redoStack = []
    /**
     * Whether the client is currently undoing (calling UndoManager.undo)
     *
     * @type {boolean}
     */
    this.undoing = false
    this.redoing = false
    /**
     * The currently popped stack item if UndoManager.undoing or UndoManager.redoing
     *
     * @type {StackItem|null}
     */
    this.currStackItem = null
    this.lastChange = 0
    this.ignoreRemoteAttributeChanges = ignoreRemoteAttributeChanges
    this.captureTimeout = captureTimeout
    /**
     * @param {Transaction} transaction
     */
    this.afterTransactionHandler = transaction => {
      // Only track certain transactions
      if (
        !this.captureTransaction(transaction) ||
        !this.scope.some(type => transaction.changedParentTypes.has(/** @type {YNode} */ (type)) || type === this.doc) ||
        (!this.trackedOrigins.has(transaction.origin) && (!transaction.origin || !this.trackedOrigins.has(transaction.origin.constructor)))
      ) {
        return
      }
      const undoing = this.undoing
      const redoing = this.redoing
      const stack = undoing ? this.redoStack : this.undoStack
      if (undoing) {
        this.stopCapturing() // next undo should not be appended to last stack item
      } else if (!redoing) {
        // neither undoing nor redoing: delete redoStack
        this.clear(false, true)
      }
      const insertions = transaction.insertSet
      const now = time.getUnixTime()
      let didAdd = false
      if (this.lastChange > 0 && now - this.lastChange < this.captureTimeout && stack.length > 0 && !undoing && !redoing) {
        // append change to last stack op
        const lastOp = stack[stack.length - 1]
        lastOp.deletes = mergeIdSets([lastOp.deletes, transaction.deleteSet])
        lastOp.inserts = mergeIdSets([lastOp.inserts, insertions])
      } else {
        // create a new stack op
        stack.push(new StackItem(insertions, transaction.deleteSet))
        didAdd = true
      }
      if (!undoing && !redoing) {
        this.lastChange = now
      }
      // make sure that deleted structs are not gc'd
      iterateStructsByIdSet(transaction, transaction.deleteSet, /** @param {Item|GC} item */ item => {
        if (item instanceof Item && this.scope.some(type => type === transaction.doc || isParentOf(/** @type {YNode} */ (type), item))) {
          keepItem(item, true)
        }
      })
      /**
       * @type {[StackItemEvent, UndoManager]}
       */
      const changeEvent = [{ stackItem: stack[stack.length - 1], origin: transaction.origin, type: undoing ? 'redo' : 'undo', changedParentTypes: transaction.changedParentTypes }, this]
      if (didAdd) {
        this.emit('stack-item-added', changeEvent)
      } else {
        this.emit('stack-item-updated', changeEvent)
      }
    }
    this.destroy = this.destroy.bind(this)
    this.doc.on('afterTransaction', this.afterTransactionHandler)
    this.doc.on('destroy', this.destroy)
    let ums = docUndoManagers.get(this.doc)
    if (ums === undefined) {
      ums = new Set()
      docUndoManagers.set(this.doc, ums)
    }
    ums.add(this)
  }

  /**
   * Extend the scope.
   *
   * @param {Array<YNode | Doc> | YNode | Doc} ynodes
   */
  addToScope (ynodes) {
    const tmpSet = new Set(this.scope)
    ynodes = array.isArray(ynodes) ? ynodes : [ynodes]
    ynodes.forEach(ynode => {
      if (!tmpSet.has(ynode)) {
        tmpSet.add(ynode)
        if (ynode instanceof YNode ? ynode.doc !== this.doc : ynode !== this.doc) logging.warn('[yjs#509] Not same Y.Doc') // use MultiDocUndoManager instead. also see https://github.com/yjs/yjs/issues/509
        this.scope.push(ynode)
      }
    })
  }

  /**
   * @param {any} origin
   */
  addTrackedOrigin (origin) {
    this.trackedOrigins.add(origin)
  }

  /**
   * @param {any} origin
   */
  removeTrackedOrigin (origin) {
    this.trackedOrigins.delete(origin)
  }

  clear (clearUndoStack = true, clearRedoStack = true) {
    if ((clearUndoStack && this.canUndo()) || (clearRedoStack && this.canRedo())) {
      this.doc.transact(tr => {
        if (clearUndoStack) {
          this.undoStack.forEach(item => clearUndoManagerStackItem(tr, this, item))
          this.undoStack = []
        }
        if (clearRedoStack) {
          this.redoStack.forEach(item => clearUndoManagerStackItem(tr, this, item))
          this.redoStack = []
        }
        rekeepDocUndoManagers(tr, this.doc)
        this.emit('stack-cleared', [{ undoStackCleared: clearUndoStack, redoStackCleared: clearRedoStack }])
      })
    }
  }

  /**
   * UndoManager merges Undo-StackItem if they are created within time-gap
   * smaller than `options.captureTimeout`. Call `um.stopCapturing()` so that the next
   * StackItem won't be merged.
   *
   *
   * @example
   *     // without stopCapturing
   *     ytext.insert(0, 'a')
   *     ytext.insert(1, 'b')
   *     um.undo()
   *     ytext.toString() // => '' (note that 'ab' was removed)
   *     // with stopCapturing
   *     ytext.insert(0, 'a')
   *     um.stopCapturing()
   *     ytext.insert(0, 'b')
   *     um.undo()
   *     ytext.toString() // => 'a' (note that only 'b' was removed)
   *
   */
  stopCapturing () {
    this.lastChange = 0
  }

  /**
   * Undo last changes on type.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  undo () {
    this.undoing = true
    let res
    try {
      res = popStackItem(this, this.undoStack, 'undo')
    } finally {
      this.undoing = false
    }
    return res
  }

  /**
   * Redo last undo operation.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  redo () {
    this.redoing = true
    let res
    try {
      res = popStackItem(this, this.redoStack, 'redo')
    } finally {
      this.redoing = false
    }
    return res
  }

  /**
   * Are undo steps available?
   *
   * @return {boolean} `true` if undo is possible
   */
  canUndo () {
    return this.undoStack.length > 0
  }

  /**
   * Are redo steps available?
   *
   * @return {boolean} `true` if redo is possible
   */
  canRedo () {
    return this.redoStack.length > 0
  }

  destroy () {
    const ums = docUndoManagers.get(this.doc)
    if (ums !== undefined) {
      ums.delete(this)
      if (ums.size === 0) {
        docUndoManagers.delete(this.doc)
      }
    }
    this.trackedOrigins.delete(this)
    this.doc.off('afterTransaction', this.afterTransactionHandler)
    this.doc.off('destroy', this.destroy)
    if (!this.doc.isDestroyed && (this.undoStack.length > 0 || this.redoStack.length > 0)) {
      this.doc.transact(tr => {
        this.undoStack.forEach(item => clearUndoManagerStackItem(tr, this, item))
        this.redoStack.forEach(item => clearUndoManagerStackItem(tr, this, item))
        this.undoStack = []
        this.redoStack = []
        rekeepDocUndoManagers(tr, this.doc)
      })
    } else {
      this.undoStack = []
      this.redoStack = []
    }
    super.destroy()
  }
}

/**
 * @experimental
 *
 * This is not guaranteed to work on documents with gc enabled!
 *
 * @param {Doc} ydoc
 * @param {ContentIds} contentIds
 * @param {UndoManagerOptions} opts
 */
export const undoContentIds = (ydoc, contentIds, opts = {}) => {
  const um = new UndoManager(ydoc, opts)
  try {
    um.undoStack.push(new StackItem(diffIdSet(contentIds.inserts, contentIds.deletes), diffIdSet(contentIds.deletes, contentIds.inserts)))
    um.undo()
  } finally {
    um.clear()
    um.destroy()
  }
}

/**
 * @param {Array<StackItem>} stack
 * @param {ID} id
 */
const isDeletedByUndoStack = (stack, id) => array.some(stack, /** @param {StackItem} s */ s => s.deletes.hasId(id))

/**
 * Redoes the effect of this operation.
 *
 * @param {Transaction} transaction The Yjs instance.
 * @param {Item} item
 * @param {Set<Item>} redoitems
 * @param {IdSet} itemsToDelete
 * @param {boolean} ignoreRemoteAttributeChanges
 * @param {import('../utils/UndoManager.js').UndoManager} um
 *
 * @return {Item|null}
 *
 * @private
 */
export const redoItem = (transaction, item, redoitems, itemsToDelete, ignoreRemoteAttributeChanges, um) => {
  const doc = transaction.doc
  const store = doc.store
  const ownClientID = doc.clientID
  const redone = item.redone
  if (redone !== null) {
    return getRedoneItem(transaction, redone)
  }
  let parentItem = /** @type {YNode} */ (item.parent)._item
  /**
   * @type {Item|null}
   */
  let left = null
  /**
   * @type {Item|null}
   */
  let right
  // make sure that parent is redone
  if (parentItem !== null && parentItem.deleted === true) {
    // try to undo parent if it will be undone anyway
    if (parentItem.redone === null && (!redoitems.has(parentItem) || redoItem(transaction, parentItem, redoitems, itemsToDelete, ignoreRemoteAttributeChanges, um) === null)) {
      return null
    }
    while (parentItem.redone !== null) {
      const nextParent = getRedoneItem(transaction, parentItem.redone)
      if (nextParent === null) {
        return null
      }
      parentItem = nextParent
    }
    if (parentItem.deleted || !(parentItem.content instanceof ContentType)) {
      return null
    }
  }
  /**
   * @type {YNode}
   */
  const parentType = /** @type {YNode} */ (parentItem === null ? item.parent : /** @type {ContentType} */ (parentItem.content).type)

  if (item.parentSub === null) {
    // Is an array item. Insert at the old position
    left = item.left
    right = item
    // find next cloned_redo items
    while (left !== null) {
      /**
       * @type {Item|null}
       */
      let leftTrace = left
      // trace redone until parent matches
      while (leftTrace !== null && /** @type {YNode} */ (leftTrace.parent)._item !== parentItem) {
        leftTrace = leftTrace.redone === null ? null : getRedoneItem(transaction, leftTrace.redone)
      }
      if (leftTrace !== null && /** @type {YNode} */ (leftTrace.parent)._item === parentItem) {
        left = leftTrace
        break
      }
      left = left.left
    }
    while (right !== null) {
      /**
       * @type {Item|null}
       */
      let rightTrace = right
      // trace redone until parent matches
      while (rightTrace !== null && /** @type {YNode} */ (rightTrace.parent)._item !== parentItem) {
        rightTrace = rightTrace.redone === null ? null : getRedoneItem(transaction, rightTrace.redone)
      }
      if (rightTrace !== null && /** @type {YNode} */ (rightTrace.parent)._item === parentItem) {
        right = rightTrace
        break
      }
      right = right.right
    }
  } else {
    right = null
    if (item.right && !ignoreRemoteAttributeChanges) {
      left = item
      // Iterate right while right is in itemsToDelete
      // If it is intended to delete right while item is redone, we can expect that item should replace right.
      while (left !== null && left.right !== null && (left.right.redone || itemsToDelete.hasId(left.right.id) || isDeletedByUndoStack(um.undoStack, left.right.id) || isDeletedByUndoStack(um.redoStack, left.right.id))) {
        left = left.right
        // follow redone
        while (left !== null && left.redone) {
          left = getRedoneItem(transaction, left.redone)
        }
      }
      if (left === null || left.right !== null) {
        // It is not possible to redo this item because it conflicts with a
        // change from another client
        return null
      }
    } else {
      left = parentType._map.get(item.parentSub) || null
    }
    if (left !== null && /** @type {YNode} */ (left.parent)._item !== parentItem) {
      left = parentType._map.get(item.parentSub) || null
    }
  }
  const nextClock = store.getClock(ownClientID)
  const nextId = createID(ownClientID, nextClock)
  const redoneItem = new Item(
    nextId,
    left, left && left.lastId,
    right, right && right.id,
    parentType,
    item.parentSub,
    item.content.copy()
  )
  item.redone = nextId
  redoneItem.integrate(transaction, 0)
  return redoneItem
}

/**
 * Make sure that neither item nor any of its parents is ever deleted.
 *
 * This property does not persist when storing it into a database or when
 * sending it to other peers
 *
 * @param {Item|null} item
 * @param {boolean} keep
 */
export const keepItem = (item, keep) => {
  while (item !== null) {
    item.keep = keep
    item = /** @type {YNode} */ (item.parent)._item
  }
}
