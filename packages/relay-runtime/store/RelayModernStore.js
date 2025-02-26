/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const DataChecker = require('./DataChecker');
const RelayModernRecord = require('./RelayModernRecord');
const RelayProfiler = require('../util/RelayProfiler');
const RelayReader = require('./RelayReader');
const RelayReferenceMarker = require('./RelayReferenceMarker');

const deepFreeze = require('../util/deepFreeze');
const defaultGetDataID = require('./defaultGetDataID');
const hasOverlappingIDs = require('./hasOverlappingIDs');
const recycleNodesInto = require('../util/recycleNodesInto');
const resolveImmediate = require('resolveImmediate');

const {UNPUBLISH_RECORD_SENTINEL} = require('./RelayStoreUtils');

import type {Disposable} from '../util/RelayRuntimeTypes';
import type {GetDataID} from './RelayResponseNormalizer';
import type {
  RequestDescriptor,
  MutableRecordSource,
  RecordSource,
  Scheduler,
  ReaderSelector,
  NormalizationSelector,
  OperationLoader,
  Snapshot,
  Store,
  UpdatedRecords,
} from './RelayStoreTypes';

type Subscription = {
  callback: (snapshot: Snapshot) => void,
  snapshot: Snapshot,
};

/**
 * @public
 *
 * An implementation of the `Store` interface defined in `RelayStoreTypes`.
 *
 * Note that a Store takes ownership of all records provided to it: other
 * objects may continue to hold a reference to such records but may not mutate
 * them. The static Relay core is architected to avoid mutating records that may have been
 * passed to a store: operations that mutate records will either create fresh
 * records or clone existing records and modify the clones. Record immutability
 * is also enforced in development mode by freezing all records passed to a store.
 */
class RelayModernStore implements Store {
  _gcScheduler: Scheduler;
  _hasScheduledGC: boolean;
  _index: number;
  _operationLoader: ?OperationLoader;
  _recordSource: MutableRecordSource;
  _roots: Map<number, NormalizationSelector>;
  _subscriptions: Set<Subscription>;
  _updatedRecordIDs: UpdatedRecords;
  _gcHoldCounter: number;
  _shouldScheduleGC: boolean;
  _getDataID: GetDataID;

  constructor(
    source: MutableRecordSource,
    gcScheduler: Scheduler = resolveImmediate,
    operationLoader: ?OperationLoader = null,
    UNSTABLE_DO_NOT_USE_getDataID?: ?GetDataID,
  ) {
    // Prevent mutation of a record from outside the store.
    if (__DEV__) {
      const storeIDs = source.getRecordIDs();
      for (let ii = 0; ii < storeIDs.length; ii++) {
        const record = source.get(storeIDs[ii]);
        if (record) {
          RelayModernRecord.freeze(record);
        }
      }
    }
    this._gcScheduler = gcScheduler;
    this._hasScheduledGC = false;
    this._index = 0;
    this._operationLoader = operationLoader;
    this._recordSource = source;
    this._roots = new Map();
    this._subscriptions = new Set();
    this._updatedRecordIDs = {};
    this._gcHoldCounter = 0;
    this._shouldScheduleGC = false;
    this._getDataID = UNSTABLE_DO_NOT_USE_getDataID ?? defaultGetDataID;
  }

  getSource(): RecordSource {
    return this._recordSource;
  }

  check(selector: NormalizationSelector): boolean {
    return DataChecker.check(
      this._recordSource,
      this._recordSource,
      selector,
      [],
      this._operationLoader,
      this._getDataID,
    );
  }

  retain(selector: NormalizationSelector): Disposable {
    const index = this._index++;
    const dispose = () => {
      this._roots.delete(index);
      this._scheduleGC();
    };
    this._roots.set(index, selector);
    return {dispose};
  }

  lookup(selector: ReaderSelector, owner: RequestDescriptor): Snapshot {
    const snapshot = RelayReader.read(this._recordSource, selector, owner);
    if (__DEV__) {
      deepFreeze(snapshot);
    }
    return snapshot;
  }

  // This method will return a list of updated owners form the subscriptions
  notify(): $ReadOnlyArray<RequestDescriptor> {
    const updatedOwners = [];
    this._subscriptions.forEach(subscription => {
      const owner = this._updateSubscription(subscription);
      if (owner != null) {
        updatedOwners.push(owner);
      }
    });
    this._updatedRecordIDs = {};
    return updatedOwners;
  }

  publish(source: RecordSource): void {
    updateTargetFromSource(this._recordSource, source, this._updatedRecordIDs);
  }

  subscribe(
    snapshot: Snapshot,
    callback: (snapshot: Snapshot) => void,
  ): Disposable {
    const subscription = {callback, snapshot};
    const dispose = () => {
      this._subscriptions.delete(subscription);
    };
    this._subscriptions.add(subscription);
    return {dispose};
  }

  holdGC(): Disposable {
    this._gcHoldCounter++;
    const dispose = () => {
      if (this._gcHoldCounter > 0) {
        this._gcHoldCounter--;
        if (this._gcHoldCounter === 0 && this._shouldScheduleGC) {
          this._scheduleGC();
          this._shouldScheduleGC = false;
        }
      }
    };
    return {dispose};
  }

  toJSON(): mixed {
    return 'RelayModernStore()';
  }

  // Internal API
  __getUpdatedRecordIDs(): UpdatedRecords {
    return this._updatedRecordIDs;
  }

  // We are returning an instance of RequestDescriptor here if the snapshot
  // were updated. We will use this information in the RelayOperationTracker
  // in order to track which owner was affected by which operation.
  _updateSubscription(subscription: Subscription): ?RequestDescriptor {
    const {callback, snapshot} = subscription;
    if (!hasOverlappingIDs(snapshot, this._updatedRecordIDs)) {
      return;
    }
    let nextSnapshot = RelayReader.read(
      this._recordSource,
      snapshot,
      snapshot.owner,
    );
    const nextData = recycleNodesInto(snapshot.data, nextSnapshot.data);
    nextSnapshot = {
      ...nextSnapshot,
      data: nextData,
    };
    if (__DEV__) {
      deepFreeze(nextSnapshot);
    }
    subscription.snapshot = nextSnapshot;
    if (nextSnapshot.data !== snapshot.data) {
      callback(nextSnapshot);
      return snapshot.owner;
    }
  }

  _scheduleGC() {
    if (this._gcHoldCounter > 0) {
      this._shouldScheduleGC = true;
      return;
    }
    if (this._hasScheduledGC) {
      return;
    }
    this._hasScheduledGC = true;
    this._gcScheduler(() => {
      this.__gc();
      this._hasScheduledGC = false;
    });
  }

  __gc(): void {
    const references = new Set();
    // Mark all records that are traversable from a root
    this._roots.forEach(selector => {
      RelayReferenceMarker.mark(
        this._recordSource,
        selector,
        references,
        this._operationLoader,
      );
    });
    // Short-circuit if *nothing* is referenced
    if (!references.size) {
      this._recordSource.clear();
      return;
    }
    // Evict any unreferenced nodes
    const storeIDs = this._recordSource.getRecordIDs();
    for (let ii = 0; ii < storeIDs.length; ii++) {
      const dataID = storeIDs[ii];
      if (!references.has(dataID)) {
        this._recordSource.remove(dataID);
      }
    }
  }
}

/**
 * Updates the target with information from source, also updating a mapping of
 * which records in the target were changed as a result.
 */
function updateTargetFromSource(
  target: MutableRecordSource,
  source: RecordSource,
  updatedRecordIDs: UpdatedRecords,
): void {
  const dataIDs = source.getRecordIDs();
  for (let ii = 0; ii < dataIDs.length; ii++) {
    const dataID = dataIDs[ii];
    const sourceRecord = source.get(dataID);
    const targetRecord = target.get(dataID);
    // Prevent mutation of a record from outside the store.
    if (__DEV__) {
      if (sourceRecord) {
        RelayModernRecord.freeze(sourceRecord);
      }
    }
    if (sourceRecord === UNPUBLISH_RECORD_SENTINEL) {
      // Unpublish a record
      target.remove(dataID);
      updatedRecordIDs[dataID] = true;
    } else if (sourceRecord && targetRecord) {
      const nextRecord = RelayModernRecord.update(targetRecord, sourceRecord);
      if (nextRecord !== targetRecord) {
        // Prevent mutation of a record from outside the store.
        if (__DEV__) {
          RelayModernRecord.freeze(nextRecord);
        }
        updatedRecordIDs[dataID] = true;
        target.set(dataID, nextRecord);
      }
    } else if (sourceRecord === null) {
      target.delete(dataID);
      if (targetRecord !== null) {
        updatedRecordIDs[dataID] = true;
      }
    } else if (sourceRecord) {
      target.set(dataID, sourceRecord);
      updatedRecordIDs[dataID] = true;
    } // don't add explicit undefined
  }
}

RelayProfiler.instrumentMethods(RelayModernStore.prototype, {
  lookup: 'RelayModernStore.prototype.lookup',
  notify: 'RelayModernStore.prototype.notify',
  publish: 'RelayModernStore.prototype.publish',
  __gc: 'RelayModernStore.prototype.__gc',
});

module.exports = RelayModernStore;
