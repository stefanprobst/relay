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

const warning = require('warning');

const {getRequest} = require('../../query/RelayModernGraphQLTag');
const {
  createOperationDescriptor,
} = require('../RelayModernOperationDescriptor');
const {
  areEqualSelectors,
  createNormalizationSelector,
  createReaderSelector,
  getDataIDsFromObject,
  getPluralSelector,
  getSelectorsFromObject,
  getSingularSelector,
  getVariablesFromObject,
} = require('../RelayModernSelector');
const {ROOT_ID} = require('../RelayStoreUtils');
const {
  createMockEnvironment,
  generateAndCompile,
  matchers,
} = require('relay-test-utils-internal');

import type {OperationDescriptor} from '../RelayStoreTypes';

describe('RelayModernSelector', () => {
  let UserFragment;
  let UserQuery;
  let UsersFragment;
  let environment;
  let zuck;
  let variables;
  let operationVariables;
  let operationDescriptor: OperationDescriptor;
  let owner;

  beforeEach(() => {
    expect.extend(matchers);
    jest.mock('warning');

    environment = createMockEnvironment();
    ({UserFragment, UserQuery, UsersFragment} = generateAndCompile(`
      query UserQuery($id: ID!, $size: Int, $cond: Boolean!) {
        node(id: $id) {
          ...UserFragment
          ...UsersFragment
        }
      }
      fragment UserFragment on User {
        id
        name
        profilePicture(size: $size) @include(if: $cond) {
          uri
        }
      }
      fragment UsersFragment on User @relay(plural: true) {
        id
        name
        profilePicture(size: $size) @include(if: $cond) {
          uri
        }
      }
    `));
    const dataID = ROOT_ID;
    variables = {id: '4', size: null, cond: false};
    operationVariables = variables;
    const fragment = createReaderSelector(
      UserQuery.fragment,
      dataID,
      variables,
    );
    const root = createNormalizationSelector(
      UserQuery.operation,
      dataID,
      variables,
    );
    operationDescriptor = {
      fragment,
      root,
      node: UserQuery,
      variables,
    };

    environment.commitPayload(operationDescriptor, {
      node: {
        id: '4',
        __typename: 'User',
        name: 'Zuck',
      },
    });
    zuck = (environment.lookup(
      createReaderSelector(UserQuery.fragment, ROOT_ID, {id: '4'}),
      operationDescriptor,
    ).data: $FlowFixMe).node;
    variables = {
      size: null,
      cond: false,
    };
  });

  describe('getSingularSelector()', () => {
    it('throws for invalid inputs', () => {
      expect(() => getSingularSelector(UserFragment, 'zuck')).toThrowError(
        'RelayModernSelector: Expected value for fragment `UserFragment` to ' +
          'be an object, got `"zuck"`.',
      );
      expect(() => getSingularSelector(UserFragment, [zuck])).toThrowError(
        'RelayModernSelector: Expected value for fragment `UserFragment` to be an object, got ' +
          '`[{"__fragments":{"UserFragment":{},"UsersFragment":{}},"__id":"4","__fragmentOwner":' +
          JSON.stringify(operationDescriptor) +
          '}]`.',
      );
    });

    it('returns null and warns for unfetched fragment data', () => {
      const selector = getSingularSelector(UserFragment, {});
      expect(warning).toHaveBeenCalledWith(
        false,
        'RelayModernSelector: Expected object to contain data for fragment ' +
          '`%s`, got `%s`. Make sure that the parent ' +
          'operation/fragment included fragment `...%s` without `@relay(mask: false)`.',
        'UserFragment',
        '{}',
        'UserFragment',
      );
      expect(selector).toBe(null);
    });

    it('returns a selector', () => {
      const queryNode = getRequest(UserQuery);
      owner = createOperationDescriptor(queryNode, operationVariables);
      zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe).node;

      const selector = getSingularSelector(UserFragment, zuck);
      expect(selector).toEqual({
        kind: 'SingularOwnedReaderSelector',
        owner: owner,
        selector: createReaderSelector(UserFragment, '4', variables),
      });
      expect(selector?.owner).toBe(owner);
    });

    it('uses variables from owner', () => {
      const queryNode = getRequest(UserQuery);
      // Pass owner with different variables
      owner = createOperationDescriptor(queryNode, {
        id: '4',
        size: 16,
        cond: true,
      });
      zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe).node;

      const selector = getSingularSelector(UserFragment, zuck);
      expect(selector).toEqual({
        kind: 'SingularOwnedReaderSelector',
        owner: owner,
        selector: createReaderSelector(UserFragment, '4', {
          size: 16,
          cond: true,
        }),
      });
      expect(selector?.owner).toBe(owner);
    });
  });

  describe('getPluralSelector()', () => {
    it('throws for invalid inputs', () => {
      expect(() => getPluralSelector(UserFragment, ['zuck'])).toThrowError(
        'RelayModernSelector: Expected value for fragment `UserFragment` to be ' +
          'an object, got `"zuck"`.',
      );
    });

    it('returns null and warns for unfetched fragment data', () => {
      const selectors = getPluralSelector(UserFragment, [{}]);
      expect(warning).toHaveBeenCalledWith(
        false,
        'RelayModernSelector: Expected object to contain data for fragment ' +
          '`%s`, got `%s`. Make sure that the parent ' +
          'operation/fragment included fragment `...%s` without `@relay(mask: false)`.',
        'UserFragment',
        '{}',
        'UserFragment',
      );
      expect(selectors).toBe(null);
    });

    it('returns selectors', () => {
      const queryNode = getRequest(UserQuery);
      owner = createOperationDescriptor(queryNode, operationVariables);
      zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe).node;

      const selector = getPluralSelector(UserFragment, [zuck]);
      expect(selector).toEqual({
        kind: 'PluralOwnedReaderSelector',
        selectors: [
          {
            kind: 'SingularOwnedReaderSelector',
            owner: owner,
            selector: createReaderSelector(UserFragment, '4', variables),
          },
        ],
      });
    });

    it('uses owner variables', () => {
      const queryNode = getRequest(UserQuery);
      // Pass owner with different variables
      owner = createOperationDescriptor(queryNode, {
        id: '4',
        size: 16,
        cond: true,
      });
      zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe).node;

      const selector = getPluralSelector(UserFragment, [zuck]);
      expect(selector).toEqual({
        kind: 'PluralOwnedReaderSelector',
        selectors: [
          {
            kind: 'SingularOwnedReaderSelector',
            owner: owner,
            selector: createReaderSelector(UserFragment, '4', {
              size: 16,
              cond: true,
            }),
          },
        ],
      });
    });
  });

  describe('getSelectorsFromObject()', () => {
    it('throws for invalid inputs', () => {
      expect(() =>
        getSelectorsFromObject({user: UserFragment}, {user: 'zuck'}),
      ).toThrowError(
        'RelayModernSelector: Expected value for fragment `UserFragment` to be an ' +
          'object, got `"zuck"`.',
      );
    });

    it('returns null and warns for unfetched fragment data', () => {
      const selectors = getSelectorsFromObject(
        {user: UserFragment},
        {user: {}},
      );
      expect(warning).toHaveBeenCalledWith(
        false,
        'RelayModernSelector: Expected object to contain data for fragment ' +
          '`%s`, got `%s`. Make sure that the parent ' +
          'operation/fragment included fragment `...%s` without `@relay(mask: false)`.',
        'UserFragment',
        '{}',
        'UserFragment',
      );
      expect(selectors).toEqual({user: null});
    });

    it('ignores keys not present in the fragment map', () => {
      const selectors = getSelectorsFromObject(
        {user: UserFragment},
        {
          user: zuck,
          foo: 'foo',
          bar: 42,
        },
      );
      expect(selectors).toEqual({
        user: {
          kind: 'SingularOwnedReaderSelector',
          owner: operationDescriptor,
          selector: createReaderSelector(UserFragment, '4', variables),
        },
      });
    });

    it('passes through null/undefined values', () => {
      let selectors = getSelectorsFromObject(
        {user: UserFragment},
        {user: null},
      );
      expect(selectors).toEqual({
        user: null,
      });
      selectors = getSelectorsFromObject(
        {user: UserFragment},
        {user: undefined},
      );
      expect(selectors).toEqual({
        user: undefined,
      });
    });

    it('returns singular selectors', () => {
      const selectors = getSelectorsFromObject(
        {user: UserFragment},
        {user: zuck},
      );
      expect(selectors).toEqual({
        user: {
          kind: 'SingularOwnedReaderSelector',
          owner: operationDescriptor,
          selector: createReaderSelector(UserFragment, '4', variables),
        },
      });
    });

    it('returns plural selectors', () => {
      const selectors = getSelectorsFromObject(
        {user: UsersFragment},
        {user: [zuck]},
      );
      expect(selectors).toEqual({
        user: {
          kind: 'PluralOwnedReaderSelector',
          selectors: [
            {
              kind: 'SingularOwnedReaderSelector',
              owner: operationDescriptor,
              selector: createReaderSelector(UsersFragment, '4', variables),
            },
          ],
        },
      });
    });

    describe('with fragment owner', () => {
      beforeEach(() => {
        const queryNode = getRequest(UserQuery);
        owner = createOperationDescriptor(queryNode, operationVariables);
        zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe)
          .node;
      });

      it('returns singular selectors', () => {
        const selectors = getSelectorsFromObject(
          {user: UserFragment},
          {user: zuck},
        );
        expect(selectors).toEqual({
          user: {
            kind: 'SingularOwnedReaderSelector',
            owner: owner,
            selector: createReaderSelector(UserFragment, '4', variables),
          },
        });
      });

      it('returns singular selector and uses variables from owner', () => {
        const queryNode = getRequest(UserQuery);
        // Pass owner with different variables
        owner = createOperationDescriptor(queryNode, {
          id: '4',
          size: 16,
          cond: true,
        });
        zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe)
          .node;
        const selectors = getSelectorsFromObject(
          {user: UserFragment},
          {user: zuck},
        );
        expect(selectors).toEqual({
          user: {
            kind: 'SingularOwnedReaderSelector',
            owner: owner,
            selector: createReaderSelector(UserFragment, '4', {
              size: 16,
              cond: true,
            }),
          },
        });
      });

      it('returns plural selectors', () => {
        const selectors = getSelectorsFromObject(
          {user: UsersFragment},
          {user: [zuck]},
        );
        expect(selectors).toEqual({
          user: {
            kind: 'PluralOwnedReaderSelector',
            selectors: [
              {
                kind: 'SingularOwnedReaderSelector',
                owner: owner,
                selector: createReaderSelector(UsersFragment, '4', variables),
              },
            ],
          },
        });
      });

      it('returns plural selectors and uses variables from owner', () => {
        const queryNode = getRequest(UserQuery);
        // Pass owner with different variables
        owner = createOperationDescriptor(queryNode, {
          id: '4',
          size: 16,
          cond: true,
        });
        zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe)
          .node;
        const selectors = getSelectorsFromObject(
          {user: UsersFragment},
          {user: [zuck]},
        );
        expect(selectors).toEqual({
          user: {
            kind: 'PluralOwnedReaderSelector',
            selectors: [
              {
                kind: 'SingularOwnedReaderSelector',
                owner: owner,
                selector: createReaderSelector(UsersFragment, '4', {
                  size: 16,
                  cond: true,
                }),
              },
            ],
          },
        });
      });
    });
  });

  describe('getDataIDsFromObject()', () => {
    it('throws for invalid inputs', () => {
      expect(() =>
        getDataIDsFromObject({user: UserFragment}, {user: 'zuck'}),
      ).toThrowError(
        'RelayModernSelector: Expected value for fragment `UserFragment` to be an ' +
          'object, got `"zuck"`.',
      );
    });

    it('returns null and warns for unfetched fragment data', () => {
      const ids = getDataIDsFromObject({user: UserFragment}, {user: {}});
      expect(warning).toHaveBeenCalledWith(
        false,
        'RelayModernSelector: Expected object to contain data for fragment ' +
          '`%s`, got `%s`. Make sure that the parent ' +
          'operation/fragment included fragment `...%s` without `@relay(mask: false)`.',
        'UserFragment',
        '{}',
        'UserFragment',
      );
      expect(ids).toEqual({user: null});
    });

    it('ignores keys not present in the fragment map', () => {
      const dataIDs = getDataIDsFromObject(
        {user: UserFragment},
        {
          user: zuck,
          foo: 'foo',
          bar: 42,
        },
      );
      expect(dataIDs).toEqual({
        user: '4',
      });
    });

    it('passes through null/undefined values', () => {
      let dataIDs = getDataIDsFromObject({user: UserFragment}, {user: null});
      expect(dataIDs).toEqual({
        user: null,
      });
      dataIDs = getDataIDsFromObject({user: UserFragment}, {user: undefined});
      expect(dataIDs).toEqual({
        user: undefined,
      });
    });

    it('returns singular ids', () => {
      const dataIDs = getDataIDsFromObject({user: UserFragment}, {user: zuck});
      expect(dataIDs).toEqual({
        user: '4',
      });
    });

    it('returns plural ids', () => {
      const dataIDs = getDataIDsFromObject(
        {user: UsersFragment},
        {user: [zuck]},
      );
      expect(dataIDs).toEqual({
        user: ['4'],
      });
    });
  });

  describe('getVariablesFromObject()', () => {
    const inputVariables = {
      cond: true,
      id: '4',
      size: 42,
      other: 'whatevs',
    };

    it('throws for invalid inputs', () => {
      expect(() =>
        getVariablesFromObject({user: UserFragment}, {user: 'zuck'}),
      ).toThrowError(
        'RelayModernSelector: Expected value for fragment `UserFragment` to be an ' +
          'object, got `"zuck"`.',
      );
    });

    it('returns empty variables and warns for unfetched fragment data', () => {
      const fragmentVariables = getVariablesFromObject(
        {user: UserFragment},
        {user: {}},
      );
      expect(warning).toHaveBeenCalledWith(
        false,
        'RelayModernSelector: Expected object to contain data for fragment ' +
          '`%s`, got `%s`. Make sure that the parent ' +
          'operation/fragment included fragment `...%s` without `@relay(mask: false)`.',
        'UserFragment',
        '{}',
        'UserFragment',
      );
      expect(fragmentVariables).toEqual({});
    });

    it('ignores keys not present in the fragment map', () => {
      variables = getVariablesFromObject(
        {user: UserFragment},
        {
          foo: 'foo',
          bar: 42,
        },
      );
      expect(variables).toEqual({});
    });

    it('ignores null/undefined values', () => {
      variables = getVariablesFromObject({user: UserFragment}, {user: null});
      expect(variables).toEqual({});
      variables = getVariablesFromObject(
        {user: UserFragment},
        {user: undefined},
      );
      expect(variables).toEqual({});
    });

    it('returns variables for singular props', () => {
      variables = getVariablesFromObject({user: UserFragment}, {user: zuck});
      expect(variables).toEqual({
        cond: false,
        size: null,
      });
    });

    it('returns variables for plural props', () => {
      variables = getVariablesFromObject(
        {user: UsersFragment},
        {user: [null, zuck, null]},
      );
      expect(variables).toEqual({
        cond: false,
        size: null,
      });
    });

    describe('with fragment owner', () => {
      beforeEach(() => {
        const queryNode = getRequest(UserQuery);
        owner = createOperationDescriptor(queryNode, inputVariables);
        zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe)
          .node;
      });

      it('returns variables for singular props', () => {
        variables = getVariablesFromObject({user: UserFragment}, {user: zuck});
        expect(variables).toEqual({
          cond: true,
          size: 42,
        });
      });
      it('returns variables for singular props and uses variables from owner', () => {
        const queryNode = getRequest(UserQuery);
        // Pass owner with different variables
        owner = createOperationDescriptor(queryNode, {
          id: '4',
          size: 16,
          cond: false,
        });
        zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe)
          .node;
        variables = getVariablesFromObject({user: UserFragment}, {user: zuck});
        expect(variables).toEqual({
          cond: false,
          size: 16,
        });
      });
      it('returns variables for plural props', () => {
        variables = getVariablesFromObject(
          {user: UsersFragment},
          {user: [zuck]},
        );
        expect(variables).toEqual({
          cond: true,
          size: 42,
        });
      });

      it('returns variables for plural props and uses variables from owner', () => {
        const queryNode = getRequest(UserQuery);
        // Pass owner with different variables
        owner = createOperationDescriptor(queryNode, {
          id: '4',
          size: 16,
          cond: false,
        });
        zuck = (environment.lookup(owner.fragment, owner).data: $FlowFixMe)
          .node;
        variables = getVariablesFromObject(
          {user: UsersFragment},
          {user: [zuck]},
        );
        expect(variables).toEqual({
          cond: false,
          size: 16,
        });
      });
    });
  });

  describe('areEqualSelectors()', () => {
    it('returns true for equivalent selectors', () => {
      const ownedSelector = {
        kind: 'SingularOwnedReaderSelector',
        owner: operationDescriptor,
        selector: createReaderSelector(UserFragment, '4', variables),
      };
      const clone = {
        ...ownedSelector,
        selector: {
          ...ownedSelector.selector,
          variables: {...ownedSelector.selector.variables},
        },
      };
      expect(areEqualSelectors(ownedSelector, ownedSelector)).toBe(true);
      expect(areEqualSelectors(ownedSelector, clone)).toBe(true);
    });

    it('returns false for equivalent selectors but with different owners', () => {
      const queryNode = getRequest(UserQuery);
      owner = createOperationDescriptor(queryNode, operationVariables);
      const selector = {
        kind: 'SingularOwnedReaderSelector',
        owner: owner,
        selector: createReaderSelector(UserFragment, '4', variables),
      };
      const clone = {
        kind: 'SingularOwnedReaderSelector',
        owner,
        selector: {
          ...selector.selector,
          variables: {...selector.selector.variables},
        },
      };
      expect(areEqualSelectors(selector, selector)).toBe(true);
      expect(areEqualSelectors(selector, clone)).toBe(true);

      // Even if the owner is different, areEqualSelectors should return false
      // if the 2 selectors represent the same selection
      const differentOwner = {
        ...selector,
        owner: {...owner, variables: {}},
      };
      expect(areEqualSelectors(selector, differentOwner)).toBe(false);
    });

    it('returns true for equivalent selectors with same owners', () => {
      const queryNode = getRequest(UserQuery);
      owner = createOperationDescriptor(queryNode, operationVariables);
      const selector = {
        kind: 'SingularOwnedReaderSelector',
        owner: owner,
        selector: createReaderSelector(UserFragment, '4', variables),
      };
      const clone = {
        kind: 'SingularOwnedReaderSelector',
        owner: owner,
        selector: {
          ...selector.selector,
          variables: {...selector.selector.variables},
        },
      };
      expect(areEqualSelectors(selector, selector)).toBe(true);
      expect(areEqualSelectors(selector, clone)).toBe(true);
    });

    it('returns false for different selectors', () => {
      const readerSelector = createReaderSelector(UserFragment, '4', variables);
      const selector = {
        kind: 'SingularOwnedReaderSelector',
        owner: operationDescriptor,
        selector: readerSelector,
      };
      const differentID = {
        ...selector,
        selector: {...readerSelector, dataID: 'beast'},
      };
      const differentNode = {
        ...selector,
        selector: {...readerSelector, node: {...readerSelector.node}},
      };
      const differentVars = {
        ...selector,
        selector: {...readerSelector, variables: {}},
      };
      expect(areEqualSelectors(selector, differentID)).toBe(false);
      expect(areEqualSelectors(selector, differentNode)).toBe(false);
      expect(areEqualSelectors(selector, differentVars)).toBe(false);
    });

    it('returns false for different selectors with owners', () => {
      const queryNode = getRequest(UserQuery);
      owner = createOperationDescriptor(queryNode, operationVariables);
      const readerSelector = createReaderSelector(UserFragment, '4', variables);
      const selector = {
        kind: 'SingularOwnedReaderSelector',
        owner: owner,
        selector: readerSelector,
      };
      const differentID = {
        ...selector,
        selector: {...readerSelector, dataID: 'beast'},
      };
      const differentNode = {
        ...selector,
        selector: {...readerSelector, node: {...readerSelector.node}},
      };
      const differentVars = {
        ...selector,
        selector: {...readerSelector, variables: {}},
      };
      const differentOwner = {
        ...selector,
        owner: {...owner},
      };
      expect(areEqualSelectors(selector, differentID)).toBe(false);
      expect(areEqualSelectors(selector, differentNode)).toBe(false);
      expect(areEqualSelectors(selector, differentVars)).toBe(false);
      expect(areEqualSelectors(selector, differentOwner)).toBe(false);
    });
  });
});
