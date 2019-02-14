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

const invariant = require('invariant');

const {DEFAULT_HANDLE_KEY} = require('../util/DefaultHandleKey');
const {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLScalarType,
  GraphQLList,
  GraphQLNonNull,
} = require('graphql');

import type {CompilerContextDocument} from './GraphQLCompilerContext';
import type {
  Argument,
  ArgumentDefinition,
  ArgumentValue,
  Directive,
  Field,
  LocalArgumentDefinition,
  Node,
  Selection,
} from './GraphQLIR';
import type {GraphQLInputType} from 'graphql';

const INDENT = '  ';

/**
 * Converts a GraphQLIR node into a GraphQL string. Custom Relay
 * extensions (directives) are not supported; to print fragments with
 * variables or fragment spreads with arguments, transform the node
 * prior to printing.
 */
function print(node: CompilerContextDocument): string {
  switch (node.kind) {
    case 'Fragment':
      return (
        `fragment ${node.name} on ${String(node.type)}` +
        printFragmentArgumentDefinitions(node.argumentDefinitions) +
        printDirectives(node.directives) +
        printSelections(node, '') +
        '\n'
      );
    case 'Root':
      return (
        `${node.operation} ${node.name}` +
        printArgumentDefinitions(node.argumentDefinitions) +
        printDirectives(node.directives) +
        printSelections(node, '') +
        '\n'
      );
    case 'SplitOperation':
      return (
        `SplitOperation ${node.name} on ${String(node.type)}` +
        printSelections(node, '') +
        '\n'
      );
    default:
      (node: empty);
      invariant(
        false,
        'GraphQLIRPrinter: Unsupported IR node `%s`.',
        node.kind,
      );
  }
}

function printSelections(
  node: Node,
  indent: string,
  parentDirectives?: string,
): string {
  const selections = node.selections;
  if (selections == null) {
    return '';
  }
  const printed = selections.map(selection =>
    printSelection(selection, indent, parentDirectives),
  );
  return printed.length
    ? ` {\n${indent + INDENT}${printed.join(
        '\n' + indent + INDENT,
      )}\n${indent}}`
    : '';
}

/**
 * Prints a field without subselections.
 */
function printField(field: Field, parentDirectives: string = ''): string {
  return (
    (field.alias != null ? field.alias + ': ' + field.name : field.name) +
    printArguments(field.args) +
    parentDirectives +
    printDirectives(field.directives) +
    printHandles(field)
  );
}

function printSelection(
  selection: Selection,
  indent: string,
  parentDirectives?: string = '',
): string {
  let str;
  if (selection.kind === 'LinkedField') {
    str = printField(selection, parentDirectives);
    str += printSelections(selection, indent + INDENT);
  } else if (selection.kind === 'MatchField') {
    str = printField(selection, parentDirectives);
    str += printSelections(selection, indent + INDENT);
  } else if (selection.kind === 'MatchBranch') {
    str = selection.selections
      .map(matchSelection => printSelection(matchSelection, indent))
      .join('\n' + indent + INDENT);
  } else if (selection.kind === 'ScalarField') {
    str = printField(selection, parentDirectives);
  } else if (selection.kind === 'InlineFragment') {
    str = '... on ' + selection.typeCondition.toString();
    str += parentDirectives;
    str += printDirectives(selection.directives);
    str += printSelections(selection, indent + INDENT);
  } else if (selection.kind === 'FragmentSpread') {
    str = '...' + selection.name;
    str += parentDirectives;
    str += printFragmentArguments(selection.args);
    str += printDirectives(selection.directives);
  } else if (selection.kind === 'Condition') {
    const value = printValue(selection.condition);
    // For Flow
    invariant(
      value != null,
      'GraphQLIRPrinter: Expected a variable for condition, got a literal `null`.',
    );
    let condStr = selection.passingValue ? ' @include' : ' @skip';
    condStr += '(if: ' + value + ')';
    condStr += parentDirectives;
    // For multi-selection conditions, pushes the condition down to each
    const subSelections = selection.selections.map(sel =>
      printSelection(sel, indent, condStr),
    );
    str = subSelections.join('\n' + INDENT);
  } else if (selection.kind === 'Stream') {
    let streamStr = ` @stream(label: "${selection.label}"`;
    if (selection.if !== null) {
      streamStr += `, if: ${printValue(selection.if) ?? ''}`;
    }
    if (selection.initialCount !== null) {
      streamStr += `, initial_count: ${printValue(selection.initialCount) ??
        ''}`;
    }
    streamStr += ')';
    streamStr += parentDirectives;
    const subSelections = selection.selections.map(sel =>
      printSelection(sel, indent, streamStr),
    );
    str = subSelections.join('\n' + INDENT);
  } else if (selection.kind === 'Defer') {
    let deferStr = ` @defer(label: "${selection.label}"`;
    if (selection.if !== null) {
      deferStr += `, if: ${printValue(selection.if) ?? ''}`;
    }
    deferStr += ')';
    deferStr += parentDirectives;
    const subSelections = selection.selections.map(sel =>
      printSelection(sel, indent, deferStr),
    );
    str = subSelections.join('\n' + INDENT);
  } else {
    (selection: empty);
    invariant(
      false,
      'GraphQLIRPrinter: Unknown selection kind `%s`.',
      selection.kind,
    );
  }
  return str;
}

function printArgumentDefinitions(
  argumentDefinitions: $ReadOnlyArray<LocalArgumentDefinition>,
): string {
  const printed = argumentDefinitions.map(def => {
    let str = `$${def.name}: ${def.type.toString()}`;
    if (def.defaultValue != null) {
      str += ' = ' + printLiteral(def.defaultValue, def.type);
    }
    return str;
  });
  return printed.length ? `(\n${INDENT}${printed.join('\n' + INDENT)}\n)` : '';
}

function printFragmentArgumentDefinitions(
  argumentDefinitions: $ReadOnlyArray<ArgumentDefinition>,
): string {
  let printed;
  argumentDefinitions.forEach(def => {
    if (def.kind !== 'LocalArgumentDefinition') {
      return;
    }
    printed = printed || [];
    let str = `${def.name}: {type: "${def.type.toString()}"`;
    if (def.defaultValue != null) {
      str += `, defaultValue: ${printLiteral(def.defaultValue, def.type)}`;
    }
    str += '}';
    printed.push(str);
  });
  return printed && printed.length
    ? ` @argumentDefinitions(\n${INDENT}${printed.join('\n' + INDENT)}\n)`
    : '';
}

function printHandles(field: Field): string {
  if (!field.handles) {
    return '';
  }
  const printed = field.handles.map(handle => {
    // For backward compatibility and also because this module is shared by ComponentScript.
    const key =
      handle.key === DEFAULT_HANDLE_KEY ? '' : `, key: "${handle.key}"`;
    const filters =
      handle.filters == null
        ? ''
        : `, filters: ${JSON.stringify(Array.from(handle.filters).sort())}`;
    return `@__clientField(handle: "${handle.name}"${key}${filters})`;
  });
  return printed.length ? ' ' + printed.join(' ') : '';
}

function printDirectives(directives: $ReadOnlyArray<Directive>): string {
  const printed = directives.map(directive => {
    return '@' + directive.name + printArguments(directive.args);
  });
  return printed.length ? ' ' + printed.join(' ') : '';
}

function printFragmentArguments(args: $ReadOnlyArray<Argument>) {
  const printedArgs = printArguments(args);
  if (!printedArgs.length) {
    return '';
  }
  return ` @arguments${printedArgs}`;
}

function printArguments(args: $ReadOnlyArray<Argument>): string {
  const printed = [];
  args.forEach(arg => {
    const printedValue = printValue(arg.value, arg.type);
    if (printedValue != null) {
      printed.push(arg.name + ': ' + printedValue);
    }
  });
  return printed.length ? '(' + printed.join(', ') + ')' : '';
}

function printValue(value: ArgumentValue, type: ?GraphQLInputType): ?string {
  if (type instanceof GraphQLNonNull) {
    type = type.ofType;
  }
  if (value.kind === 'Variable') {
    return '$' + value.variableName;
  } else if (value.kind === 'ObjectValue') {
    invariant(
      type instanceof GraphQLInputObjectType,
      'GraphQLIRPrinter: Need an InputObject type to print objects.',
    );

    const typeFields = type.getFields();
    const pairs = value.fields
      .map(field => {
        const innerValue = printValue(field.value, typeFields[field.name].type);
        return innerValue == null ? null : field.name + ': ' + innerValue;
      })
      .filter(Boolean);

    return '{' + pairs.join(', ') + '}';
  } else if (value.kind === 'ListValue') {
    invariant(
      type instanceof GraphQLList,
      'GraphQLIRPrinter: Need a type in order to print arrays.',
    );
    const innerType = type.ofType;
    return `[${value.items.map(i => printValue(i, innerType)).join(', ')}]`;
  } else if (value.value != null) {
    return printLiteral(value.value, type);
  } else {
    return null;
  }
}

function printLiteral(value: mixed, type: ?GraphQLInputType): string {
  if (type instanceof GraphQLNonNull) {
    type = type.ofType;
  }
  if (type instanceof GraphQLEnumType) {
    const result = type.serialize(value);
    invariant(
      typeof result === 'string',
      'GraphQLIRPrinter: Expected value of type %s to be a valid enum value, got `%s`.',
      type.name,
      value,
    );
    return result;
  }
  if (type instanceof GraphQLScalarType && value != null) {
    const result = type.serialize(value);
    return JSON.stringify(result);
  }
  if (Array.isArray(value)) {
    invariant(
      type instanceof GraphQLList,
      'GraphQLIRPrinter: Need a type in order to print arrays.',
    );
    const itemType = type.ofType;
    return (
      '[' + value.map(item => printLiteral(item, itemType)).join(', ') + ']'
    );
  } else if (typeof value === 'object' && value != null) {
    const fields = [];
    invariant(
      type instanceof GraphQLInputObjectType,
      'GraphQLIRPrinter: Need an InputObject type to print objects.',
    );
    const typeFields = type.getFields();
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        fields.push(
          key + ': ' + printLiteral(value[key], typeFields[key].type),
        );
      }
    }
    return '{' + fields.join(', ') + '}';
  } else if (type instanceof GraphQLList && value != null) {
    // Not an array, but still a list. Treat as list-of-one as per spec 3.1.7:
    // http://facebook.github.io/graphql/October2016/#sec-Lists
    return printLiteral(value, type.ofType);
  } else {
    return JSON.stringify(value);
  }
}

module.exports = {print, printField, printArguments, printDirectives};
