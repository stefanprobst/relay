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

const {
  createOperationDescriptor,
} = require('../store/RelayModernOperationDescriptor');
const {getRequest} = require('./RelayModernGraphQLTag');

import type {Environment} from '../store/RelayStoreTypes';
import type {CacheConfig, OperationType} from '../util/RelayRuntimeTypes';
import type {GraphQLTaggedNode} from './RelayModernGraphQLTag';

/**
 * A helper function to fetch the results of a query. Note that results for
 * fragment spreads are masked: fields must be explicitly listed in the query in
 * order to be accessible in the result object.
 */

function fetchQuery<T: OperationType>(
  environment: Environment,
  taggedNode: GraphQLTaggedNode,
  variables: $PropertyType<T, 'variables'>,
  cacheConfig?: ?CacheConfig,
): Promise<$PropertyType<T, 'response'>> {
  const query = getRequest(taggedNode);
  if (query.params.operationKind !== 'query') {
    throw new Error('fetchQuery: Expected query operation');
  }
  const operation = createOperationDescriptor(query, variables);
  return environment
    .execute({operation, cacheConfig})
    .map(() => environment.lookup(operation.fragment, operation).data)
    .toPromise();
}

module.exports = fetchQuery;
