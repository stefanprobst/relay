/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @emails oncall+relay
 */

'use strict';

const RelayModernOperationDescriptor = require('../RelayModernOperationDescriptor');
const RelayRecordSource = require('../RelayRecordSource');

const {getRequest} = require('../../query/RelayModernGraphQLTag');
const {createReaderSelector} = require('../RelayModernSelector');
const {read} = require('../RelayReader');
const {ROOT_ID} = require('../RelayStoreUtils');
const {
  generateAndCompile,
  generateWithTransforms,
} = require('relay-test-utils-internal');

function createOperationDescriptor(...args) {
  const operation = RelayModernOperationDescriptor.createOperationDescriptor(
    ...args,
  );
  // For convenience of the test output, override toJSON to print
  // a more succint description of the operation.
  // $FlowFixMe
  operation.toJSON = () => {
    return {
      name: operation.fragment.node.name,
      variables: operation.variables,
    };
  };
  return operation;
}

describe('RelayReader', () => {
  let source;

  beforeEach(() => {
    const data = {
      '1': {
        __id: '1',
        id: '1',
        __typename: 'User',
        firstName: 'Alice',
        'friends(first:3)': {__ref: 'client:1'},
        'profilePicture(size:32)': {__ref: 'client:4'},
        'profilePicture(size:80)': {__ref: 'client:5'},
      },
      '2': {
        __id: '2',
        __typename: 'User',
        id: '2',
        firstName: 'Bob',
      },
      '3': {
        __id: '3',
        __typename: 'User',
        id: '3',
        firstName: 'Claire',
      },
      'client:1': {
        __id: 'client:1',
        __typename: 'FriendsConnection',
        edges: {
          __refs: ['client:2', null, 'client:3'],
        },
      },
      'client:2': {
        __id: 'client:2',
        __typename: 'FriendsConnectionEdge',
        cursor: 'cursor:2',
        node: {__ref: '2'},
      },
      'client:3': {
        __id: 'client:3',
        __typename: 'FriendsConnectionEdge',
        cursor: 'cursor:3',
        node: {__ref: '3'},
      },
      'client:4': {
        __id: 'client:4',
        __typename: 'Photo',
        uri: 'https://example.com/32.png',
      },
      'client:5': {
        __id: 'client:5',
        __typename: 'Photo',
        uri: 'https://example.com/80.png',
      },
      'client:root': {
        __id: 'client:root',
        __typename: '__Root',
        'node(id:"1")': {__ref: '1'},
      },
    };

    source = RelayRecordSource.create(data);
  });

  it('reads query data', () => {
    const {FooQuery} = generateWithTransforms(`
      query FooQuery($id: ID, $size: [Int]) {
        node(id: $id) {
          id
          __typename
          ... on Page {
            actors {
              name
            }
          }
          ... on User {
            firstName
            friends(first: 3) {
              edges {
                cursor
                node {
                  id
                  firstName
                }
              }
            }
            profilePicture(size: $size) {
              uri
            }
          }
        }
      }
    `);
    const {data, seenRecords} = read(
      source,
      createReaderSelector(FooQuery.fragment, ROOT_ID, {id: '1', size: 32}),
    );
    expect(data).toEqual({
      node: {
        id: '1',
        __typename: 'User',
        firstName: 'Alice',
        friends: {
          edges: [
            {
              cursor: 'cursor:2',
              node: {
                id: '2',
                firstName: 'Bob',
              },
            },
            null,
            {
              cursor: 'cursor:3',
              node: {
                id: '3',
                firstName: 'Claire',
              },
            },
          ],
        },
        profilePicture: {
          uri: 'https://example.com/32.png',
        },
      },
    });
    expect(Object.keys(seenRecords)).toEqual([
      '1',
      '2',
      '3',
      'client:root',
      'client:1',
      'client:2',
      'client:3',
      'client:4',
    ]);
  });

  it('reads fragment data', () => {
    const {BarFragment} = generateWithTransforms(`
      fragment BarFragment on User @argumentDefinitions(
        size: {type: "[Int]"}
      ) {
        id
        firstName
        friends(first: 3) {
          edges {
            cursor
            node {
              id
              firstName
            }
          }
        }
        profilePicture(size: $size) {
          uri
        }
      }
    `);
    const {data, seenRecords} = read(
      source,
      createReaderSelector(BarFragment, '1', {size: 32}),
    );
    expect(data).toEqual({
      id: '1',
      firstName: 'Alice',
      friends: {
        edges: [
          {
            cursor: 'cursor:2',
            node: {
              id: '2',
              firstName: 'Bob',
            },
          },
          null,
          {
            cursor: 'cursor:3',
            node: {
              id: '3',
              firstName: 'Claire',
            },
          },
        ],
      },
      profilePicture: {
        uri: 'https://example.com/32.png',
      },
    });
    expect(Object.keys(seenRecords)).toEqual([
      '1',
      '2',
      '3',
      'client:1',
      'client:2',
      'client:3',
      'client:4',
    ]);
  });

  it('creates fragment pointers with fragment owner when owner is provided', () => {
    const {ParentQuery, UserProfile} = generateAndCompile(`
      query ParentQuery($size: Float!) {
        me {
          ...UserProfile
        }
      }

      fragment UserProfile on User {
        id
        name
        ...UserProfilePicture
      }

      fragment UserProfilePicture on User {
        profilePicture(size: $size) {
          uri
        }
      }
    `);

    const queryNode = getRequest(ParentQuery);
    const owner = createOperationDescriptor(queryNode, {size: 42});
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserProfile, '1', {size: 42}),
      owner,
    );
    expect(data).toEqual({
      id: '1',
      __id: '1',
      __fragments: {
        UserProfilePicture: {},
      },
      __fragmentOwner: owner,
    });
    expect(data.__fragmentOwner).toBe(owner);
    expect(Object.keys(seenRecords)).toEqual(['1']);
  });

  it('creates fragment pointers with variable @arguments', () => {
    const {UserProfile, UserQuery} = generateAndCompile(`
      query UserQuery {
        me {
          ...UserProfile
        }
      }

      fragment UserProfile on User @argumentDefinitions(
        size: {type: "[Int]"}
      ) {
        id
        ...UserProfilePicture @arguments(size: $size)
      }

      fragment UserProfilePicture on User @argumentDefinitions(
        size: {type: "[Int]"}
      ) {
        profilePicture(size: $size) {
          uri
        }
      }
    `);

    const owner = createOperationDescriptor(UserQuery, {});
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserProfile, '1', {size: 42}),
      owner,
    );
    expect(data).toEqual({
      id: '1',
      __id: '1',
      __fragments: {
        UserProfilePicture: {
          size: 42,
        },
      },
      __fragmentOwner: owner,
    });
    expect(Object.keys(seenRecords)).toEqual(['1']);
  });

  it('creates fragment pointers with literal @arguments', () => {
    const {UserProfile, UserQuery} = generateAndCompile(`
      query UserQuery {
        me {
          ...UserProfile
        }
      }

      fragment UserProfile on User {
        id
        ...UserProfilePicture @arguments(size: 42)
      }

      fragment UserProfilePicture on User @argumentDefinitions(
        size: {type: "[Int]"}
      ) {
        profilePicture(size: $size) {
          uri
        }
      }
    `);

    const owner = createOperationDescriptor(UserQuery, {});
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserProfile, '1', {}),
      owner,
    );
    expect(data).toEqual({
      id: '1',
      __id: '1',
      __fragments: {
        UserProfilePicture: {
          size: 42,
        },
      },
      __fragmentOwner: owner,
    });
    expect(Object.keys(seenRecords)).toEqual(['1']);
  });

  describe('@inline', () => {
    it('reads a basic fragment', () => {
      const {UserProfile} = generateAndCompile(`
        fragment UserProfile on User  {
          id
          ...UserProfilePicture
        }
        fragment UserProfilePicture on User @inline {
          profilePicture(size: 32) {
            uri
          }
        }
      `);
      const {data, seenRecords} = read(
        source,
        createReaderSelector(UserProfile, '1', {}),
      );
      expect(data).toEqual({
        id: '1',
        __id: '1',
        __fragments: {
          UserProfilePicture: {
            profilePicture: {uri: 'https://example.com/32.png'},
          },
        },
      });
      expect(Object.keys(seenRecords)).toEqual(['1', 'client:4']);
    });

    // it('uses global variables', () => {
    //   const {UserProfile} = generateAndCompile(`
    //     fragment UserProfile on User  {
    //       id
    //       ...UserProfilePicture
    //     }
    //     fragment UserProfilePicture on User @inline {
    //       profilePicture(size: $globalSize) {
    //         uri
    //       }
    //     }
    //   `);
    //   const {data, seenRecords} = read(source, {
    //     dataID: '1',
    //     node: UserProfile,
    //     variables: {
    //       globalSize: 32,
    //     },
    //   });
    //   expect(data).toEqual({
    //     id: '1',
    //     __id: '1',
    //     __fragments: {
    //       UserProfilePicture: {
    //         profilePicture: {uri: 'https://example.com/32.png'},
    //       },
    //     },
    //   });
    //   expect(Object.keys(seenRecords)).toEqual(['1', 'client:4']);
    // });

    // it('creates inline data fragment pointers', () => {
    //   const {UserProfile} = generateAndCompile(`
    //     fragment UserProfile on User @argumentDefinitions(
    //       globalSize: {type: "[Int]"}
    //     ) {
    //       id
    //       ...UserProfilePicture # @arguments(argSize: $globalSize)
    //     }
    //
    //     fragment UserProfilePicture on User @inline @argumentDefinitions(
    //       argSize: {type: "[Int]"}
    //     ) {
    //       profilePicture(size: $argSize) {
    //         uri
    //       }
    //     }
    //   `);
    //
    //   const {data, seenRecords} = read(source, {
    //     dataID: '1',
    //     node: UserProfile,
    //     variables: {
    //       globalSize: 32
    //     },
    //   });
    //   expect(data).toEqual({
    //     id: '1',
    //     __id: '1',
    //     __fragments: {
    //       UserProfilePicture: {
    //         profilePicture: {uri: 'https://example.com/32.png'},
    //       },
    //     },
    //   });
    //   expect(Object.keys(seenRecords)).toEqual(['1', 'client:4']);
    // });

    // test('@inline works with default arguments', () => {
    //   const {UserProfile} = generateAndCompile(`
    //     fragment UserProfile on User {
    //       ...UserProfilePicture
    //     }
    //
    //     fragment UserProfilePicture on User @inline @argumentDefinitions(
    //       size: {type: "[Int]", defaultValue: 32}
    //     ) {
    //       profilePicture(size: 32) {
    //         uri
    //       }
    //     }
    //   `);
    //
    //   const {data, seenRecords} = read(source, {
    //     dataID: '1',
    //     node: UserProfile,
    //     variables: {},
    //   });
    //   expect(data).toEqual({
    //     __id: '1',
    //     __fragments: {
    //       UserProfilePicture: {
    //         profilePicture: {uri: 'https://example.com/32.png'},
    //       },
    //     },
    //   });
    //   expect(Object.keys(seenRecords)).toEqual(['1', 'client:4']);
    // });
  });

  it('reads data when the root is deleted', () => {
    const {UserProfile} = generateAndCompile(`
      fragment UserProfile on User {
        name
      }
    `);
    source = RelayRecordSource.create();
    source.delete('4');
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserProfile, '4', {}),
    );
    expect(data).toBe(null);
    expect(Object.keys(seenRecords)).toEqual(['4']);
  });

  it('reads data when the root is unfetched', () => {
    const {UserProfile} = generateAndCompile(`
      fragment UserProfile on User {
        name
      }
    `);
    source = RelayRecordSource.create();
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserProfile, '4', {}),
    );
    expect(data).toBe(undefined);
    expect(Object.keys(seenRecords)).toEqual(['4']);
  });

  it('reads "handle" fields for query root fragments', () => {
    const records = {
      '1': {
        __id: '1',
        __typename: 'User',
        __friends_bestFriends: {__ref: 'client:bestFriends'},
      },
      '2': {
        __id: '2',
        __typename: 'User',
        id: '2',
        __name_friendsName: 'handleName',
      },
      'client:bestFriends': {
        __id: 'client:bestFriends',
        __typename: 'FriendsConnection',
        edges: {
          __refs: ['client:bestFriendsEdge'],
        },
      },
      'client:bestFriendsEdge': {
        __id: 'client:bestFriendsEdge',
        __typename: 'FriendsConnectionEdge',
        cursor: 'cursor:bestFriendsEdge',
        node: {__ref: '2'},
      },
      'client:root': {
        __id: 'client:root',
        __typename: '__Root',
        'node(id:"1")': {__ref: '1'},
      },
    };
    source = RelayRecordSource.create(records);
    const {UserFriends} = generateAndCompile(`
      query UserFriends($id: ID!) {
        node(id: $id) {
          ... on User {
            friends(first: 1) @__clientField(handle: "bestFriends") {
              edges {
                cursor
                node {
                  id
                  name @__clientField(handle: "friendsName")
                }
              }
            }
          }
        }
      }
    `);
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserFriends.fragment, ROOT_ID, {id: '1'}),
    );
    expect(data).toEqual({
      node: {
        friends: {
          edges: [
            {
              cursor: 'cursor:bestFriendsEdge',
              node: {
                id: '2',
                name: 'handleName',
              },
            },
          ],
        },
      },
    });
    expect(Object.keys(seenRecords).sort()).toEqual([
      '1',
      '2',
      'client:bestFriends',
      'client:bestFriendsEdge',
      'client:root',
    ]);
  });

  it('reads "handle" fields for fragments', () => {
    const records = {
      '1': {
        __id: '1',
        __typename: 'User',
        __friends_bestFriends: {__ref: 'client:bestFriends'},
      },
      '2': {
        __id: '2',
        __typename: 'User',
        id: '2',
        __name_friendsName: 'handleName',
      },
      'client:bestFriends': {
        __id: 'client:bestFriends',
        __typename: 'FriendsConnection',
        edges: {
          __refs: ['client:bestFriendsEdge'],
        },
      },
      'client:bestFriendsEdge': {
        __id: 'client:bestFriendsEdge',
        __typename: 'FriendsConnectionEdge',
        cursor: 'cursor:bestFriendsEdge',
        node: {__ref: '2'},
      },
    };
    source = RelayRecordSource.create(records);
    const {UserFriends} = generateAndCompile(`
      fragment UserFriends on User {
        friends(first: 1) @__clientField(handle: "bestFriends") {
          edges {
            cursor
            node {
              id
              name @__clientField(handle: "friendsName")
            }
          }
        }
      }
    `);
    const {data, seenRecords} = read(
      source,
      createReaderSelector(UserFriends, '1', {}),
    );
    expect(data).toEqual({
      friends: {
        edges: [
          {
            cursor: 'cursor:bestFriendsEdge',
            node: {
              id: '2',
              name: 'handleName',
            },
          },
        ],
      },
    });
    expect(Object.keys(seenRecords).sort()).toEqual([
      '1',
      '2',
      'client:bestFriends',
      'client:bestFriendsEdge',
    ]);
  });

  describe('when @match directive is present', () => {
    let BarFragment;
    let BarQuery;

    beforeEach(() => {
      const nodes = generateAndCompile(`
        fragment PlainUserNameRenderer_name on PlainUserNameRenderer {
          plaintext
        }

        fragment MarkdownUserNameRenderer_name on MarkdownUserNameRenderer {
          markdown
        }

        fragment BarFragment on User {
          id
          nameRenderer @match {
            ...PlainUserNameRenderer_name
              @module(name: "PlainUserNameRenderer.react")
            ...MarkdownUserNameRenderer_name
              @module(name: "MarkdownUserNameRenderer.react")
          }
        }

        query BarQuery {
          me {
            ...BarFragment
          }
        }
      `);
      BarFragment = nodes.BarFragment;
      BarQuery = nodes.BarQuery;
    });

    it('creates fragment and module pointers for fragment that matches resolved type (1)', () => {
      // When the type matches PlainUserNameRenderer
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          'nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': {
            __ref:
              'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          },
        },
        'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': {
          __id:
            'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          __typename: 'PlainUserNameRenderer',
          __module_component_BarFragment: 'PlainUserNameRenderer.react',
          __module_operation_BarFragment:
            'PlainUserNameRenderer_name$normalization.graphql',
          plaintext: 'plain name',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const owner = createOperationDescriptor(BarQuery, {});
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
        owner,
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: {
          __id:
            'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          __fragments: {
            PlainUserNameRenderer_name: {},
          },
          __fragmentOwner: owner,
          __fragmentPropName: 'name',
          __module_component: 'PlainUserNameRenderer.react',
        },
      });
      expect(Object.keys(seenRecords)).toEqual([
        '1',
        'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
      ]);
      expect(isMissingData).toBe(false);
    });

    it('creates fragment and module pointers for fragment that matches resolved type (2)', () => {
      // When the type matches MarkdownUserNameRenderer
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          'nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': {
            __ref:
              'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          },
        },
        'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': {
          __id:
            'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          __typename: 'MarkdownUserNameRenderer',
          __module_component_BarFragment: 'MarkdownUserNameRenderer.react',
          __module_operation_BarFragment:
            'MarkdownUserNameRenderer_name$normalization.graphql',
          markdown: 'markdown payload',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const owner = createOperationDescriptor(BarQuery, {});
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
        owner,
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: {
          __id:
            'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          __fragments: {
            MarkdownUserNameRenderer_name: {},
          },
          __fragmentOwner: owner,
          __fragmentPropName: 'name',
          __module_component: 'MarkdownUserNameRenderer.react',
        },
      });
      expect(Object.keys(seenRecords)).toEqual([
        '1',
        'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
      ]);
      expect(isMissingData).toBe(false);
    });

    it('reads data correctly when the resolved type does not match any of the specified cases', () => {
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          'nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': {
            __ref:
              'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          },
        },
        'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': {
          __id:
            'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
          __typename: 'CustomNameRenderer',
          customField: 'custom value',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: {}, // type doesn't match selections, no data provided
      });
      expect(Object.keys(seenRecords)).toEqual([
        '1',
        'client:1:nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])',
      ]);
      expect(isMissingData).toBe(false);
    });

    it('reads data correctly when the match field record is null', () => {
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          'nameRenderer(supported:["PlainUserNameRenderer","MarkdownUserNameRenderer"])': null,
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: null,
      });
      expect(Object.keys(seenRecords)).toEqual(['1']);
      expect(isMissingData).toBe(false);
    });

    it('reads data correctly when the match field record is missing', () => {
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: undefined,
      });
      expect(Object.keys(seenRecords)).toEqual(['1']);
      expect(isMissingData).toBe(true);
    });
  });

  describe('@module', () => {
    let BarQuery;
    let BarFragment;

    beforeEach(() => {
      const nodes = generateAndCompile(`
        fragment PlainUserNameRenderer_name on PlainUserNameRenderer {
          plaintext
        }

        fragment MarkdownUserNameRenderer_name on MarkdownUserNameRenderer {
          markdown
        }

        fragment BarFragment on User {
          id
          nameRenderer { # intentionally no @match here
            ...PlainUserNameRenderer_name
              @module(name: "PlainUserNameRenderer.react")
            ...MarkdownUserNameRenderer_name
              @module(name: "MarkdownUserNameRenderer.react")
          }
        }

        query BarQuery {
          me {
            ...BarFragment
          }
        }
      `);
      BarFragment = nodes.BarFragment;
      BarQuery = nodes.BarQuery;
    });

    it('creates fragment and module pointers when the type matches a @module selection (1)', () => {
      // When the type matches PlainUserNameRenderer
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          nameRenderer: {
            __ref: 'client:1:nameRenderer',
          },
        },
        'client:1:nameRenderer': {
          __id: 'client:1:nameRenderer',
          __typename: 'PlainUserNameRenderer',
          __module_component_BarFragment: 'PlainUserNameRenderer.react',
          __module_operation_BarFragment:
            'PlainUserNameRenderer_name$normalization.graphql',
          plaintext: 'plain name',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const owner = createOperationDescriptor(BarQuery, {});
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
        owner,
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: {
          __id: 'client:1:nameRenderer',
          __fragments: {
            PlainUserNameRenderer_name: {},
          },
          __fragmentOwner: owner,
          __fragmentPropName: 'name',
          __module_component: 'PlainUserNameRenderer.react',
        },
      });
      expect(Object.keys(seenRecords)).toEqual(['1', 'client:1:nameRenderer']);
      expect(isMissingData).toBe(false);
    });

    it('creates fragment and module pointers when the type matches a @module selection (2)', () => {
      // When the type matches MarkdownUserNameRenderer
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          nameRenderer: {
            __ref: 'client:1:nameRenderer',
          },
        },
        'client:1:nameRenderer': {
          __id: 'client:1:nameRenderer',
          __typename: 'MarkdownUserNameRenderer',
          __module_component_BarFragment: 'MarkdownUserNameRenderer.react',
          __module_operation_BarFragment:
            'MarkdownUserNameRenderer_name$normalization.graphql',
          markdown: 'markdown payload',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const owner = createOperationDescriptor(BarQuery, {});
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
        owner,
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: {
          __id: 'client:1:nameRenderer',
          __fragments: {
            MarkdownUserNameRenderer_name: {},
          },
          __fragmentOwner: owner,
          __fragmentPropName: 'name',
          __module_component: 'MarkdownUserNameRenderer.react',
        },
      });
      expect(Object.keys(seenRecords)).toEqual(['1', 'client:1:nameRenderer']);
      expect(isMissingData).toBe(false);
    });

    it('reads data correctly when the resolved type does not match any of the @module selections', () => {
      const storeData = {
        '1': {
          __id: '1',
          id: '1',
          __typename: 'User',
          nameRenderer: {
            __ref: 'client:1:nameRenderer',
          },
        },
        'client:1:nameRenderer': {
          __id: 'client:1:nameRenderer',
          __typename: 'CustomNameRenderer',
          customField: 'custom value',
        },
        'client:root': {
          __id: 'client:root',
          __typename: '__Root',
          'node(id:"1")': {__ref: '1'},
        },
      };
      source = RelayRecordSource.create(storeData);
      const {data, seenRecords, isMissingData} = read(
        source,
        createReaderSelector(BarFragment, '1', {}),
      );
      expect(data).toEqual({
        id: '1',
        nameRenderer: {}, // type doesn't match selections, no data provided
      });
      expect(Object.keys(seenRecords)).toEqual(['1', 'client:1:nameRenderer']);
      expect(isMissingData).toBe(false);
    });
  });

  describe('`isMissingData` field', () => {
    describe('readScalar', () => {
      it('should have `isMissingData = false` if data is available', () => {
        const {UserProfile} = generateAndCompile(`
          fragment UserProfile on User {
            id
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserProfile, '1', {}),
        );
        expect(data.id).toBe('1');
        expect(isMissingData).toBe(false);
      });

      it('should have `isMissingData = true` if data is missing', () => {
        const {UserProfile} = generateAndCompile(`
          fragment UserProfile on User {
            id
            username
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserProfile, '1', {}),
        );
        expect(data.id).toBe('1');
        expect(data.username).not.toBeDefined();
        expect(isMissingData).toBe(true);
      });
    });

    describe('readLink', () => {
      it('should have `isMissingData = false` if data is available', () => {
        const {ProfilePicture} = generateAndCompile(`
          fragment ProfilePicture on User {
            id
            profilePicture(size: $size) {
              uri
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(ProfilePicture, '1', {
            size: 32,
          }),
        );
        expect(data.profilePicture.uri).toEqual('https://example.com/32.png');
        expect(isMissingData).toBe(false);
      });

      it('should have `isMissingData = true` if data is missing', () => {
        const {Address} = generateAndCompile(`
          fragment Address on User {
            id
            address {
              city
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(Address, '1', {}),
        );
        expect(data.id).toBe('1');
        expect(data.address).not.toBeDefined();
        expect(isMissingData).toBe(true);
      });

      it('should have `isMissingData = true` if data is missing (variables)', () => {
        const {ProfilePicture} = generateAndCompile(`
          fragment ProfilePicture on User {
            id
            profilePicture(size: $size) {
              uri
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(ProfilePicture, '1', {
            size: 48,
          }),
        );
        expect(data.id).toBe('1');
        expect(data.profilePicture).not.toBeDefined();
        expect(isMissingData).toBe(true);
      });
    });

    describe('readPluralLink', () => {
      beforeEach(() => {
        const data = {
          '1': {
            __id: '1',
            id: '1',
            __typename: 'User',
            firstName: 'Alice',
            'friends(first:3)': {__ref: 'client:1'},
          },
          '2': {
            __id: '2',
            __typename: 'User',
            id: '2',
            firstName: 'Bob',
            'friends(first:2)': {__ref: 'client:4'},
          },
          '3': {
            __id: '3',
            __typename: 'User',
            id: '3',
            firstName: 'Claire',
            'friends(first:1)': {__ref: 'client:5'},
          },
          'client:1': {
            __id: 'client:1',
            __typename: 'FriendsConnection',
            edges: {
              __refs: ['client:2', null, 'client:3'],
            },
          },
          'client:2': {
            __id: 'client:2',
            __typename: 'FriendsConnectionEdge',
            cursor: 'cursor:2',
            node: {__ref: '2'},
          },
          'client:3': {
            __id: 'client:3',
            __typename: 'FriendsConnectionEdge',
            cursor: 'cursor:3',
            node: {__ref: '3'},
          },
          'client:4': {
            __id: 'client:2',
            __typename: 'FriendsConnection',
          },
          'client:5': {
            __id: 'client:3',
            __typename: 'FriendsConnection',
            edges: {
              __refs: [undefined],
            },
          },
          'client:root': {
            __id: 'client:root',
            __typename: '__Root',
            'node(id:"1")': {__ref: '1'},
          },
        };

        source = RelayRecordSource.create(data);
      });

      it('should have `isMissingData = false` if data is available', () => {
        const {UserFriends} = generateAndCompile(`
          fragment UserFriends on User {
            id
            friends(first: 3) {
              edges {
                cursor
                node {
                  id
                }
              }
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserFriends, '1', {}),
        );
        expect(data.friends.edges).toEqual([
          {
            cursor: 'cursor:2',
            node: {
              id: '2',
            },
          },
          null,
          {
            cursor: 'cursor:3',
            node: {
              id: '3',
            },
          },
        ]);
        expect(isMissingData).toBe(false);
      });

      it('should have `isMissingData = true` if data is missing in the node', () => {
        const {UserFriends} = generateAndCompile(`
          fragment UserFriends on User {
            id
            friends(first: 3) {
              edges {
                cursor
                node {
                  id
                  username
                }
              }
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserFriends, '1', {}),
        );
        expect(data.friends.edges).toEqual([
          {
            cursor: 'cursor:2',
            node: {
              id: '2',
            },
          },
          null,
          {
            cursor: 'cursor:3',
            node: {
              id: '3',
            },
          },
        ]);
        expect(isMissingData).toBe(true);
      });

      it('should have `isMissingData = true` if data is missing for connection', () => {
        const {UserFriends} = generateAndCompile(`
          fragment UserFriends on User {
            id
            friends(first: 2) {
              edges {
                cursor
                node {
                  id
                }
              }
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserFriends, '2', {}),
        );
        expect(data.id).toBe('2');
        expect(data.friends.edges).not.toBeDefined();
        expect(isMissingData).toBe(true);
      });

      it('should have `isMissingData = true` if data is missing for edge in the connection', () => {
        const {UserFriends} = generateAndCompile(`
          fragment UserFriends on User {
            id
            friends(first: 1) {
              edges {
                cursor
                node {
                  id
                }
              }
            }
          }
        `);
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserFriends, '3', {}),
        );
        expect(data.id).toBe('3');
        expect(data.friends.edges).toEqual([undefined]);
        expect(isMissingData).toBe(true);
      });

      it('should not have missing data if missing fields are client fields', () => {
        const {UserProfile} = generateAndCompile(
          `fragment UserProfile on User {
            id
            friends(first: 3) {
              client_friends_connection_field
              edges {
                cursor
                node {
                  id
                  firstName
                  client_foo {
                    client_name
                  }
                }
              }
            }
            nickname
            client_actor_field
            client_foo {
              client_name
              profile_picture(scale: 2) {
                uri
              }
            }
            # Top-level linked client field
            best_friends {
              edges {
                # Nested client field
                client_friend_edge_field
                cursor
                node {
                  id
                  # Nested inline fragment
                  ... on Actor {
                    client_actor_field
                    profilePicture(size: $size) {
                      uri
                      height
                      width
                    }
                  }
                }
              }
            }
            ... on Actor {
              client_actor_field
            }
          }
          extend type User {
            nickname: String
            best_friends: FriendsConnection
            client_actor_field: String
            client_foo: Foo
          }
          extend type Page {
            client_actor_field: String
          }
          extend type FriendsEdge {
            client_friend_edge_field: String
          }
          extend type FriendsConnection {
            client_friends_connection_field: String
          }
          extend interface Actor {
            client_actor_field: String
          }
          type Foo {
            client_name: String
            profile_picture(scale: Float): Image
          }
        `,
        );
        const {data, isMissingData} = read(
          source,
          createReaderSelector(UserProfile, '1', {}),
        );
        expect(data.id).toBe('1');
        expect(isMissingData).toBe(false);
      });
    });
  });
});
