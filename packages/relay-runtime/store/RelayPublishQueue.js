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

const ErrorUtils = require('ErrorUtils');
const RelayReader = require('./RelayReader');
const RelayRecordSource = require('./RelayRecordSource');
const RelayRecordSourceMutator = require('../mutations/RelayRecordSourceMutator');
const RelayRecordSourceProxy = require('../mutations/RelayRecordSourceProxy');
const RelayRecordSourceSelectorProxy = require('../mutations/RelayRecordSourceSelectorProxy');

const invariant = require('invariant');
const normalizeRelayPayload = require('./normalizeRelayPayload');

import type {HandlerProvider} from '../handlers/RelayDefaultHandlerProvider';
import type {Disposable} from '../util/RelayRuntimeTypes';
import type {GetDataID} from './RelayResponseNormalizer';
import type {
  RequestDescriptor,
  HandleFieldPayload,
  MutableRecordSource,
  OperationDescriptor,
  OptimisticUpdate,
  PublishQueue,
  ReaderSelector,
  RecordSource,
  RelayResponsePayload,
  SelectorData,
  SelectorStoreUpdater,
  Store,
  StoreUpdater,
} from './RelayStoreTypes';

type Payload = {
  fieldPayloads: ?Array<HandleFieldPayload>,
  operation: OperationDescriptor,
  source: MutableRecordSource,
  updater: ?SelectorStoreUpdater,
};

type DataToCommit =
  | {
      kind: 'payload',
      payload: Payload,
    }
  | {
      kind: 'source',
      source: RecordSource,
    };

/**
 * Coordinates the concurrent modification of a `Store` due to optimistic and
 * non-revertable client updates and server payloads:
 * - Applies optimistic updates.
 * - Reverts optimistic updates, rebasing any subsequent updates.
 * - Commits client updates (typically for client schema extensions).
 * - Commits server updates:
 *   - Normalizes query/mutation/subscription responses.
 *   - Executes handlers for "handle" fields.
 *   - Reverts and reapplies pending optimistic updates.
 */
class RelayPublishQueue implements PublishQueue {
  _store: Store;
  _handlerProvider: ?HandlerProvider;
  _getDataID: GetDataID;

  // A "negative" of all applied updaters. It can be published to the store to
  // undo them in order to re-apply some of them for a rebase.
  _backup: MutableRecordSource;
  // True if the next `run()` should apply the backup and rerun all optimistic
  // updates performing a rebase.
  _pendingBackupRebase: boolean;
  // Payloads to apply or Sources to publish to the store with the next `run()`.
  _pendingData: Set<DataToCommit>;
  // Updaters to apply with the next `run()`. These mutate the store and should
  // typically only mutate client schema extensions.
  _pendingUpdaters: Set<StoreUpdater>;
  // Optimistic updaters to add with the next `run()`.
  _pendingOptimisticUpdates: Set<OptimisticUpdate>;
  // Optimistic updaters that are already added and might be rerun in order to
  // rebase them.
  _appliedOptimisticUpdates: Set<OptimisticUpdate>;
  // Garbage collection hold, should rerun gc on dispose
  _gcHold: ?Disposable;

  constructor(
    store: Store,
    handlerProvider?: ?HandlerProvider,
    getDataID: GetDataID,
  ) {
    this._backup = RelayRecordSource.create();
    this._handlerProvider = handlerProvider || null;
    this._pendingBackupRebase = false;
    this._pendingUpdaters = new Set();
    this._pendingData = new Set();
    this._pendingOptimisticUpdates = new Set();
    this._store = store;
    this._appliedOptimisticUpdates = new Set();
    this._gcHold = null;
    this._getDataID = getDataID;
  }

  /**
   * Schedule applying an optimistic updates on the next `run()`.
   */
  applyUpdate(updater: OptimisticUpdate): void {
    invariant(
      !this._appliedOptimisticUpdates.has(updater) &&
        !this._pendingOptimisticUpdates.has(updater),
      'RelayPublishQueue: Cannot apply the same update function more than ' +
        'once concurrently.',
    );
    this._pendingOptimisticUpdates.add(updater);
  }

  /**
   * Schedule reverting an optimistic updates on the next `run()`.
   */
  revertUpdate(updater: OptimisticUpdate): void {
    if (this._pendingOptimisticUpdates.has(updater)) {
      // Reverted before it was applied
      this._pendingOptimisticUpdates.delete(updater);
    } else if (this._appliedOptimisticUpdates.has(updater)) {
      this._pendingBackupRebase = true;
      this._appliedOptimisticUpdates.delete(updater);
    }
  }

  /**
   * Schedule a revert of all optimistic updates on the next `run()`.
   */
  revertAll(): void {
    this._pendingBackupRebase = true;
    this._pendingOptimisticUpdates.clear();
    this._appliedOptimisticUpdates.clear();
  }

  /**
   * Schedule applying a payload to the store on the next `run()`.
   */
  commitPayload(
    operation: OperationDescriptor,
    {fieldPayloads, source}: RelayResponsePayload,
    updater?: ?SelectorStoreUpdater,
  ): void {
    this._pendingBackupRebase = true;
    this._pendingData.add({
      kind: 'payload',
      payload: {fieldPayloads, operation, source, updater},
    });
  }

  /**
   * Schedule an updater to mutate the store on the next `run()` typically to
   * update client schema fields.
   */
  commitUpdate(updater: StoreUpdater): void {
    this._pendingBackupRebase = true;
    this._pendingUpdaters.add(updater);
  }

  /**
   * Schedule a publish to the store from the provided source on the next
   * `run()`. As an example, to update the store with substituted fields that
   * are missing in the store.
   */
  commitSource(source: RecordSource): void {
    this._pendingBackupRebase = true;
    this._pendingData.add({kind: 'source', source});
  }

  /**
   * Execute all queued up operations from the other public methods.
   */
  run(): $ReadOnlyArray<RequestDescriptor> {
    if (this._pendingBackupRebase && this._backup.size()) {
      this._store.publish(this._backup);
      this._backup = RelayRecordSource.create();
    }
    this._commitData();
    this._commitUpdaters();
    this._applyUpdates();
    this._pendingBackupRebase = false;
    if (this._appliedOptimisticUpdates.size > 0) {
      if (!this._gcHold) {
        this._gcHold = this._store.holdGC();
      }
    } else {
      if (this._gcHold) {
        this._gcHold.dispose();
        this._gcHold = null;
      }
    }
    return this._store.notify();
  }

  _getSourceFromPayload(payload: Payload): RecordSource {
    const {fieldPayloads, operation, source, updater} = payload;
    const mutator = new RelayRecordSourceMutator(
      this._store.getSource(),
      source,
    );
    const store = new RelayRecordSourceProxy(mutator, this._getDataID);
    if (fieldPayloads && fieldPayloads.length) {
      fieldPayloads.forEach(fieldPayload => {
        const handler =
          this._handlerProvider && this._handlerProvider(fieldPayload.handle);
        invariant(
          handler,
          'RelayModernEnvironment: Expected a handler to be provided for ' +
            'handle `%s`.',
          fieldPayload.handle,
        );
        handler.update(store, fieldPayload);
      });
    }
    if (updater) {
      const selector = operation.fragment;
      invariant(
        selector != null,
        'RelayModernEnvironment: Expected a selector to be provided with updater function.',
      );
      const selectorStore = new RelayRecordSourceSelectorProxy(store, selector);
      const selectorData = lookupSelector(source, selector, operation);
      updater(selectorStore, selectorData);
    }
    return source;
  }

  _commitData(): void {
    if (!this._pendingData.size) {
      return;
    }
    this._pendingData.forEach(data => {
      let source;
      if (data.kind === 'payload') {
        source = this._getSourceFromPayload(data.payload);
      } else {
        source = data.source;
      }
      this._store.publish(source);
    });
    this._pendingData.clear();
  }

  _commitUpdaters(): void {
    if (!this._pendingUpdaters.size) {
      return;
    }
    const sink = RelayRecordSource.create();
    this._pendingUpdaters.forEach(updater => {
      const mutator = new RelayRecordSourceMutator(
        this._store.getSource(),
        sink,
      );
      const store = new RelayRecordSourceProxy(mutator, this._getDataID);
      ErrorUtils.applyWithGuard(
        updater,
        null,
        [store],
        null,
        'RelayPublishQueue:commitUpdaters',
      );
    });
    this._store.publish(sink);
    this._pendingUpdaters.clear();
  }

  _applyUpdates(): void {
    if (
      this._pendingOptimisticUpdates.size ||
      (this._pendingBackupRebase && this._appliedOptimisticUpdates.size)
    ) {
      const sink = RelayRecordSource.create();
      const mutator = new RelayRecordSourceMutator(
        this._store.getSource(),
        sink,
        this._backup,
      );
      const store = new RelayRecordSourceProxy(
        mutator,
        this._getDataID,
        this._handlerProvider,
      );

      // rerun all updaters in case we are running a rebase
      if (this._pendingBackupRebase && this._appliedOptimisticUpdates.size) {
        this._appliedOptimisticUpdates.forEach(optimisticUpdate => {
          if (optimisticUpdate.operation) {
            const {
              selectorStoreUpdater,
              operation,
              response,
            } = optimisticUpdate;
            const selectorStore = store.commitPayload(operation, response);
            // TODO: Fix commitPayload so we don't have to run normalize twice
            let selectorData, source;
            if (response) {
              ({source} = normalizeRelayPayload(
                operation.root,
                response,
                null,
                {getDataID: this._getDataID},
              ));
              selectorData = lookupSelector(
                source,
                operation.fragment,
                operation,
              );
            }
            selectorStoreUpdater &&
              ErrorUtils.applyWithGuard(
                selectorStoreUpdater,
                null,
                [selectorStore, selectorData],
                null,
                'RelayPublishQueue:applyUpdates',
              );
          } else if (optimisticUpdate.storeUpdater) {
            const {storeUpdater} = optimisticUpdate;
            ErrorUtils.applyWithGuard(
              storeUpdater,
              null,
              [store],
              null,
              'RelayPublishQueue:applyUpdates',
            );
          } else {
            const {source, fieldPayloads} = optimisticUpdate;
            store.publishSource(source, fieldPayloads);
          }
        });
      }

      // apply any new updaters
      if (this._pendingOptimisticUpdates.size) {
        this._pendingOptimisticUpdates.forEach(optimisticUpdate => {
          if (optimisticUpdate.operation) {
            const {
              selectorStoreUpdater,
              operation,
              response,
            } = optimisticUpdate;
            const selectorStore = store.commitPayload(operation, response);
            // TODO: Fix commitPayload so we don't have to run normalize twice
            let selectorData, source;
            if (response) {
              ({source} = normalizeRelayPayload(
                operation.root,
                response,
                null,
                {getDataID: this._getDataID},
              ));
              selectorData = lookupSelector(
                source,
                operation.fragment,
                operation,
              );
            }
            selectorStoreUpdater &&
              ErrorUtils.applyWithGuard(
                selectorStoreUpdater,
                null,
                [selectorStore, selectorData],
                null,
                'RelayPublishQueue:applyUpdates',
              );
          } else if (optimisticUpdate.storeUpdater) {
            const {storeUpdater} = optimisticUpdate;
            ErrorUtils.applyWithGuard(
              storeUpdater,
              null,
              [store],
              null,
              'RelayPublishQueue:applyUpdates',
            );
          } else {
            const {source, fieldPayloads} = optimisticUpdate;
            store.publishSource(source, fieldPayloads);
          }
          this._appliedOptimisticUpdates.add(optimisticUpdate);
        });
        this._pendingOptimisticUpdates.clear();
      }

      this._store.publish(sink);
    }
  }
}

function lookupSelector(
  source: RecordSource,
  selector: ReaderSelector,
  owner: OperationDescriptor,
): ?SelectorData {
  const selectorData = RelayReader.read(source, selector, owner).data;
  if (__DEV__) {
    const deepFreeze = require('../util/deepFreeze');
    if (selectorData) {
      deepFreeze(selectorData);
    }
  }
  return selectorData;
}

module.exports = RelayPublishQueue;
