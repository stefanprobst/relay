/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const areEqual = require('areEqual');
const invariant = require('invariant');
const isScalarAndEqual = require('../util/isScalarAndEqual');

const {
  areEqualSelectors,
  createNormalizationSelector,
  createReaderSelector,
  getSelectorsFromObject,
} = require('./RelayModernSelector');
const {ROOT_ID} = require('./RelayStoreUtils');

import type {ConcreteRequest} from '../util/RelayConcreteNode';
import type {Disposable, Variables} from '../util/RelayRuntimeTypes';
import type {
  Environment,
  FragmentMap,
  FragmentSpecResolver,
  FragmentSpecResults,
  PluralOwnedReaderSelector,
  RelayContext,
  SelectorData,
  SingularOwnedReaderSelector,
  Snapshot,
} from './RelayStoreTypes';

type Props = {[key: string]: mixed};
type Resolvers = {[key: string]: ?(SelectorListResolver | SelectorResolver)};

/**
 * A utility for resolving and subscribing to the results of a fragment spec
 * (key -> fragment mapping) given some "props" that determine the root ID
 * and variables to use when reading each fragment. When props are changed via
 * `setProps()`, the resolver will update its results and subscriptions
 * accordingly. Internally, the resolver:
 * - Converts the fragment map & props map into a map of `Selector`s.
 * - Removes any resolvers for any props that became null.
 * - Creates resolvers for any props that became non-null.
 * - Updates resolvers with the latest props.
 *
 * This utility is implemented as an imperative, stateful API for performance
 * reasons: reusing previous resolvers, callback functions, and subscriptions
 * all helps to reduce object allocation and thereby decrease GC time.
 *
 * The `resolve()` function is also lazy and memoized: changes in the store mark
 * the resolver as stale and notify the caller, and the actual results are
 * recomputed the first time `resolve()` is called.
 */
class RelayModernFragmentSpecResolver implements FragmentSpecResolver {
  _callback: ?() => void;
  _context: RelayContext;
  _data: Object;
  _fragments: FragmentMap;
  _props: Props;
  _resolvers: Resolvers;
  _stale: boolean;

  constructor(
    context: RelayContext,
    fragments: FragmentMap,
    props: Props,
    callback?: () => void,
  ) {
    this._callback = callback;
    this._context = context;
    this._data = {};
    this._fragments = fragments;
    this._props = props;
    this._resolvers = {};
    this._stale = false;

    this.setProps(props);
  }

  dispose(): void {
    for (const key in this._resolvers) {
      if (this._resolvers.hasOwnProperty(key)) {
        disposeCallback(this._resolvers[key]);
      }
    }
  }

  resolve(): FragmentSpecResults {
    if (this._stale) {
      // Avoid mapping the object multiple times, which could occur if data for
      // multiple keys changes in the same event loop.
      const prevData = this._data;
      let nextData;
      for (const key in this._resolvers) {
        if (this._resolvers.hasOwnProperty(key)) {
          const resolver = this._resolvers[key];
          const prevItem = prevData[key];
          if (resolver) {
            const nextItem = resolver.resolve();
            if (nextData || nextItem !== prevItem) {
              nextData = nextData || {...prevData};
              nextData[key] = nextItem;
            }
          } else {
            const prop = this._props[key];
            const nextItem = prop !== undefined ? prop : null;
            if (nextData || !isScalarAndEqual(nextItem, prevItem)) {
              nextData = nextData || {...prevData};
              nextData[key] = nextItem;
            }
          }
        }
      }
      this._data = nextData || prevData;
      this._stale = false;
    }
    return this._data;
  }

  setCallback(callback: () => void): void {
    this._callback = callback;
  }

  setProps(props: Props): void {
    const ownedSelectors = getSelectorsFromObject(this._fragments, props);
    for (const key in ownedSelectors) {
      if (ownedSelectors.hasOwnProperty(key)) {
        const ownedSelector = ownedSelectors[key];
        let resolver = this._resolvers[key];
        if (ownedSelector == null) {
          if (resolver != null) {
            resolver.dispose();
          }
          resolver = null;
        } else if (ownedSelector.kind === 'PluralOwnedReaderSelector') {
          if (resolver == null) {
            resolver = new SelectorListResolver(
              this._context.environment,
              ownedSelector,
              this._onChange,
            );
          } else {
            invariant(
              resolver instanceof SelectorListResolver,
              'RelayModernFragmentSpecResolver: Expected prop `%s` to always be an array.',
              key,
            );
            resolver.setSelector(ownedSelector);
          }
        } else {
          if (resolver == null) {
            resolver = new SelectorResolver(
              this._context.environment,
              ownedSelector,
              this._onChange,
            );
          } else {
            invariant(
              resolver instanceof SelectorResolver,
              'RelayModernFragmentSpecResolver: Expected prop `%s` to always be an object.',
              key,
            );
            resolver.setSelector(ownedSelector);
          }
        }
        this._resolvers[key] = resolver;
      }
    }
    this._props = props;
    this._stale = true;
  }

  setVariables(variables: Variables, request: ConcreteRequest): void {
    for (const key in this._resolvers) {
      if (this._resolvers.hasOwnProperty(key)) {
        const resolver = this._resolvers[key];
        if (resolver) {
          resolver.setVariables(variables, request);
        }
      }
    }
    this._stale = true;
  }

  _onChange = (): void => {
    this._stale = true;

    if (typeof this._callback === 'function') {
      this._callback();
    }
  };
}

/**
 * A resolver for a single Selector.
 */
class SelectorResolver {
  _callback: () => void;
  _data: ?SelectorData;
  _environment: Environment;
  _ownedSelector: SingularOwnedReaderSelector;
  _subscription: ?Disposable;

  constructor(
    environment: Environment,
    ownedSelector: SingularOwnedReaderSelector,
    callback: () => void,
  ) {
    const snapshot = environment.lookup(
      ownedSelector.selector,
      ownedSelector.owner,
    );
    this._callback = callback;
    this._data = snapshot.data;
    this._environment = environment;
    this._ownedSelector = ownedSelector;
    this._subscription = environment.subscribe(snapshot, this._onChange);
  }

  dispose(): void {
    if (this._subscription) {
      this._subscription.dispose();
      this._subscription = null;
    }
  }

  resolve(): ?Object {
    return this._data;
  }

  setSelector(ownedSelector: SingularOwnedReaderSelector): void {
    if (
      this._subscription != null &&
      areEqualSelectors(ownedSelector, this._ownedSelector)
    ) {
      return;
    }
    this.dispose();
    const snapshot = this._environment.lookup(
      ownedSelector.selector,
      ownedSelector.owner,
    );
    this._data = snapshot.data;
    this._ownedSelector = ownedSelector;
    this._subscription = this._environment.subscribe(snapshot, this._onChange);
  }

  setVariables(variables: Variables, request: ConcreteRequest): void {
    if (areEqual(variables, this._ownedSelector.selector.variables)) {
      // If we're not actually setting new variables, we don't actually want
      // to create a new fragment owner, since areEqualSelectors relies on
      // owner identity when fragment ownership is enabled.
      // In fact, we don't even need to try to attempt to set a new selector.
      // When fragment ownership is not enabled, setSelector will also bail
      // out since the selector doesn't really change, so we're doing it here
      // earlier.
      return;
    }
    const ownedSelector: SingularOwnedReaderSelector = {
      kind: 'SingularOwnedReaderSelector',
      owner:
        // NOTE: We manually create the operation descriptor here instead of
        // calling createOperationDescriptor() because we want to set a
        // descriptor with *unaltered* variables as the fragment owner.
        // This is a hack that allows us to preserve exisiting (broken)
        // behavior of RelayModern containers while using fragment ownership
        // to propagate variables instead of Context.
        // For more details, see the summary of D13999308
        {
          fragment: createReaderSelector(request.fragment, ROOT_ID, variables),
          node: request,
          root: createNormalizationSelector(
            request.operation,
            ROOT_ID,
            variables,
          ),
          variables,
        },
      selector: {
        ...this._ownedSelector.selector,
        variables,
      },
    };
    this.setSelector(ownedSelector);
  }

  _onChange = (snapshot: Snapshot): void => {
    this._data = snapshot.data;
    this._callback();
  };
}

/**
 * A resolver for an array of Selectors.
 */
class SelectorListResolver {
  _callback: () => void;
  _data: Array<?SelectorData>;
  _environment: Environment;
  _resolvers: Array<SelectorResolver>;
  _stale: boolean;

  constructor(
    environment: Environment,
    selector: PluralOwnedReaderSelector,
    callback: () => void,
  ) {
    this._callback = callback;
    this._data = [];
    this._environment = environment;
    this._resolvers = [];
    this._stale = true;

    this.setSelector(selector);
  }

  dispose(): void {
    this._resolvers.forEach(disposeCallback);
  }

  resolve(): Array<?Object> {
    if (this._stale) {
      // Avoid mapping the array multiple times, which could occur if data for
      // multiple indices changes in the same event loop.
      const prevData = this._data;
      let nextData;
      for (let ii = 0; ii < this._resolvers.length; ii++) {
        const prevItem = prevData[ii];
        const nextItem = this._resolvers[ii].resolve();
        if (nextData || nextItem !== prevItem) {
          nextData = nextData || prevData.slice(0, ii);
          nextData.push(nextItem);
        }
      }
      if (!nextData && this._resolvers.length !== prevData.length) {
        nextData = prevData.slice(0, this._resolvers.length);
      }
      this._data = nextData || prevData;
      this._stale = false;
    }
    return this._data;
  }

  setSelector(selector: PluralOwnedReaderSelector): void {
    const {selectors} = selector;
    while (this._resolvers.length > selectors.length) {
      const resolver = this._resolvers.pop();
      resolver.dispose();
    }
    for (let ii = 0; ii < selectors.length; ii++) {
      if (ii < this._resolvers.length) {
        this._resolvers[ii].setSelector(selectors[ii]);
      } else {
        this._resolvers[ii] = new SelectorResolver(
          this._environment,
          selectors[ii],
          this._onChange,
        );
      }
    }
    this._stale = true;
  }

  setVariables(variables: Variables, request: ConcreteRequest): void {
    this._resolvers.forEach(resolver =>
      resolver.setVariables(variables, request),
    );
    this._stale = true;
  }

  _onChange = (data: ?Object): void => {
    this._stale = true;
    this._callback();
  };
}

function disposeCallback(disposable: ?Disposable): void {
  disposable && disposable.dispose();
}

module.exports = RelayModernFragmentSpecResolver;
