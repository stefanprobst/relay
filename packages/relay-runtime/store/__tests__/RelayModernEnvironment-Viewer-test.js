/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow
 * @emails oncall+relay
 */

'use strict';

const RelayModernEnvironment = require('../RelayModernEnvironment');
const RelayModernStore = require('../RelayModernStore');
const RelayNetwork = require('../../network/RelayNetwork');
const RelayObservable = require('../../network/RelayObservable');
const RelayRecordSource = require('../RelayRecordSource');

const commitMutation = require('../../mutations/commitMutation');

const {
  createOperationDescriptor,
} = require('../RelayModernOperationDescriptor');
const {createReaderSelector} = require('../RelayModernSelector');
const {ROOT_ID} = require('../RelayStoreUtils');
const {generateAndCompile} = require('relay-test-utils-internal');

describe('Mutations on viewer', () => {
  let dataSource;
  let environment;
  let mutation;
  let onCompleted;
  let onError;
  let variables;
  let source;
  let store;

  beforeEach(() => {
    ({SetLocation: mutation} = generateAndCompile(`
        mutation SetLocation($input: LocationInput!) {
          setLocation(input: $input) {
            viewer {
              marketplace_settings {
                location {
                  latitude
                  longitude
                }
              }
            }
          }
        }
      `));
    variables = {
      input: {
        longitude: 30.0,
        latitude: 30.0,
      },
    };

    onCompleted = jest.fn();
    onError = jest.fn();
    const fetch = (_query, _variables, _cacheConfig) => {
      return RelayObservable.create(sink => {
        dataSource = sink;
      });
    };
    source = RelayRecordSource.create({});
    store = new RelayModernStore(source);
    environment = new RelayModernEnvironment({
      network: RelayNetwork.create(fetch),
      store,
    });
  });

  it("doesn't overwrite existing data in a mutation under viewer field", () => {
    const {ShortCutQuery} = generateAndCompile(`
      query ShortCutQuery {
        viewer {
          marketplace_settings {
            categories
          }
        }
      }`);
    const payload = {
      viewer: {
        marketplace_settings: {
          categories: ['a', 'b', 'c'],
        },
      },
    };

    const selector = createReaderSelector(ShortCutQuery.fragment, ROOT_ID, {});
    const operationDescriptor = createOperationDescriptor(ShortCutQuery, {});
    const callback = jest.fn();
    const snapshot = environment.lookup(selector, operationDescriptor);
    environment.subscribe(snapshot, callback);

    environment.commitPayload(operationDescriptor, payload);
    expect(callback).toBeCalledTimes(1);
    expect(callback.mock.calls[0][0].data).toEqual({
      viewer: {marketplace_settings: {categories: ['a', 'b', 'c']}},
    });

    callback.mockClear();
    commitMutation(environment, {
      mutation,
      variables,
      onCompleted,
      onError,
    });

    dataSource.next({
      data: {
        setLocation: {
          viewer: {
            marketplace_settings: {
              location: {
                latitude: 30.0,
                longitude: 30.0,
              },
            },
          },
        },
      },
    });
    expect(callback).toBeCalledTimes(0); // no changes to selector result
  });

  it('stores data onto viewer field when no viewer field exists in the store, and it can be queried, ', () => {
    const {LocationQuery} = generateAndCompile(`
      query LocationQuery {
        viewer {
          marketplace_settings {
            location {
              latitude
              longitude
            }
          }
        }
      }`);

    const selector = createReaderSelector(LocationQuery.fragment, ROOT_ID, {});
    const operationDescriptor = createOperationDescriptor(LocationQuery, {});
    const snapshot = environment.lookup(selector, operationDescriptor);
    const callback = jest.fn();
    environment.subscribe(snapshot, callback);

    commitMutation(environment, {
      mutation,
      variables,
      onCompleted,
      onError,
    });
    dataSource.next({
      data: {
        setLocation: {
          viewer: {
            marketplace_settings: {
              location: {
                latitude: 30.0,
                longitude: 30.0,
              },
            },
          },
        },
      },
    });
    environment.check(operationDescriptor.root); // fill in missing viewer
    expect(callback).toBeCalledTimes(2);
    expect(callback.mock.calls[0][0].data).toEqual({
      viewer: undefined,
    });
    expect(callback.mock.calls[1][0].data).toEqual({
      viewer: {
        marketplace_settings: {
          location: {
            latitude: 30,
            longitude: 30,
          },
        },
      },
    });
  });
});
