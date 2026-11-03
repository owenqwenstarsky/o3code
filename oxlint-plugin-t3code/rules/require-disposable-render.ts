import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const BROWSER_TEST_FILE = /\.browser\.test\.[cm]?[jt]sx?$/u;
const LIFECYCLE_HOOKS = new Set(["afterAll", "afterEach", "beforeAll", "beforeEach"]);
const TEST_RUNNERS = new Set(["@effect/vitest", "vite-plus/test", "vitest"]);
const REACT_ACT_EXPORTS = new Set(["act", "unstable_act"]);
const ACT_ENVIRONMENT = "IS_REACT_ACT_ENVIRONMENT";
const RENDER_HELPER = /(?:^|\/)test\/render(?:\.tsx)?$/u;
const LOCATOR_QUERY = /^getBy/u;
// Locator methods that dispatch real input through the browser provider.
const LOCATOR_INPUT = new Set([
  "clear",
  "click",
  "dblClick",
  "dropTo",
  "fill",
  "hover",
  "selectOptions",
  "tripleClick",
  "unhover",
  "upload",
]);
// These leave the locator for a DOM element, whose click() is synthetic and fine inside act.
const LOCATOR_EXITS = new Set(["element", "elements", "query"]);
const HELPER = "Render with `await using screen = await render(...)` from apps/web/test/render.tsx";

const MESSAGES = {
  reactDomClient: `${HELPER}; it owns the React root and unmounts it on dispose.`,
  reactAct: `${HELPER} and import \`act\` from there; it enables React's act environment only while act runs.`,
  actEnvironment: `${HELPER}; its act() sets ${ACT_ENVIRONMENT} for exactly as long as it runs.`,
  actAroundInput:
    "Do not wrap real input (userEvent or a locator's click/fill) in act; the browser runner flushes React updates after real input. Await the input directly.",
  undisposedRender: `${HELPER}, register it with an AsyncDisposableStack, or dispose it in a finally block.`,
  lifecycleHook:
    "Browser tests acquire what they need with `using`/`await using` instead of lifecycle hooks, so nothing outlives the test that created it.",
};

const stringValue = (node: ESTree.Node | null | undefined) =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

const importedName = (specifier: ESTree.ImportSpecifier) =>
  specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;

const isFunction = (node: ESTree.Node) =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration";

// Walks a.b().c().d back to its root, reporting whether a getBy* query built a locator on the way
// without leaving it through element()/query().
const isLocatorChain = (node: ESTree.Node): boolean => {
  let sawQuery = false;
  for (let current: ESTree.Node | undefined = node; current;) {
    if (current.type === "CallExpression") {
      current = current.callee;
      continue;
    }
    if (current.type !== "MemberExpression") break;
    const name = Option.getOrUndefined(getPropertyName(current.property));
    if (name !== undefined && LOCATOR_EXITS.has(name)) return false;
    if (name !== undefined && LOCATOR_QUERY.test(name)) sawQuery = true;
    current = current.object;
  }
  return sawQuery;
};

const namesActEnvironment = (node: unknown) => {
  const target = unwrapExpression(node);
  if (Option.isNone(target)) return false;
  if (target.value.type === "Identifier") return target.value.name === ACT_ENVIRONMENT;
  if (target.value.type !== "MemberExpression") return false;
  const property = target.value.computed
    ? Option.fromNullishOr(stringValue(target.value.property))
    : getPropertyName(target.value.property);
  return Option.getOrUndefined(property) === ACT_ENVIRONMENT;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require web component tests to render through the disposable test helper instead of managing React roots, act, or lifecycle hooks by hand.",
    },
  },
  create(context) {
    const isBrowserTest = BROWSER_TEST_FILE.test(context.filename);
    // Local names bound to React's act or the render helper's act.
    const actNames = new Set<string>();
    const reactNamespaces = new Set<string>();
    const runnerNamespaces = new Set<string>();
    const userEventNames = new Set<string>();

    const namespaceMember = (node: ESTree.Node, namespaces: ReadonlySet<string>) =>
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      namespaces.has(node.object.name)
        ? Option.getOrUndefined(getPropertyName(node.property))
        : undefined;

    const isReactNamespaceAct = (callee: ESTree.Node) => {
      const member = namespaceMember(callee, reactNamespaces);
      return member !== undefined && REACT_ACT_EXPORTS.has(member);
    };

    const isActCall = (node: ESTree.Node) =>
      node.type === "CallExpression" &&
      ((node.callee.type === "Identifier" && actNames.has(node.callee.name)) ||
        isReactNamespaceAct(node.callee));

    // A function defined inside act but not passed straight to a call may run after act settles.
    const isInsideAct = (node: ESTree.Node) => {
      for (let current = node.parent; current; current = current.parent) {
        if (isActCall(current)) return true;
        if (
          isFunction(current) &&
          !(
            current.parent?.type === "CallExpression" &&
            (current.parent.arguments as ReadonlyArray<ESTree.Node>).includes(current)
          )
        ) {
          return false;
        }
      }
      return false;
    };

    const isRealInput = (callee: ESTree.MemberExpression) => {
      if (callee.object.type === "Identifier" && userEventNames.has(callee.object.name)) {
        return true;
      }
      const method = Option.getOrUndefined(getPropertyName(callee.property));
      return method !== undefined && LOCATOR_INPUT.has(method) && isLocatorChain(callee.object);
    };

    const isRenderCall = (callee: ESTree.Node) => {
      const identifier =
        callee.type === "Identifier"
          ? callee
          : callee.type === "MemberExpression" &&
              callee.object.type === "Identifier" &&
              Option.getOrUndefined(getPropertyName(callee.property)) === "render"
            ? callee.object
            : undefined;
      if (!identifier) return false;
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable)
          return variable.defs.some(
            (def) =>
              def.type === "ImportBinding" &&
              def.parent?.type === "ImportDeclaration" &&
              RENDER_HELPER.test(def.parent.source.value) &&
              (callee.type === "Identifier"
                ? def.node.type === "ImportSpecifier" && importedName(def.node) === "render"
                : def.node.type === "ImportNamespaceSpecifier"),
          );
        if (!scope.upper) return false;
        scope = scope.upper;
      }
    };

    const isDisposedRender = (node: ESTree.CallExpression) => {
      const awaited = node.parent;
      if (awaited?.type !== "AwaitExpression") return false;
      const owner = awaited.parent;
      if (
        owner?.type === "CallExpression" &&
        owner.callee.type === "MemberExpression" &&
        Option.getOrUndefined(getPropertyName(owner.callee.property)) === "use"
      )
        return true;
      if (owner?.type !== "VariableDeclarator" || owner.parent.type !== "VariableDeclaration")
        return false;
      if (owner.parent.kind === "await using") return true;
      if (owner.id.type !== "Identifier") return false;
      const name = owner.id.name;
      const declaration = owner.parent;
      const block = declaration.parent;
      if (block?.type !== "BlockStatement") return false;
      const next = block.body[block.body.indexOf(declaration) + 1];
      return (
        next?.type === "TryStatement" &&
        next.finalizer?.body.some((statement) => {
          if (
            statement.type !== "ExpressionStatement" ||
            statement.expression.type !== "AwaitExpression"
          )
            return false;
          const call = statement.expression.argument;
          if (call.type !== "CallExpression" || call.callee.type !== "MemberExpression")
            return false;
          const member = call.callee;
          return (
            member.object.type === "Identifier" &&
            member.object.name === name &&
            member.computed &&
            member.property.type === "MemberExpression" &&
            member.property.object.type === "Identifier" &&
            member.property.object.name === "Symbol" &&
            Option.getOrUndefined(getPropertyName(member.property.property)) === "asyncDispose"
          );
        })
      );
    };

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && importedName(specifier) === "userEvent") {
            userEventNames.add(specifier.local.name);
          }
        }
        if (isBrowserTest && TEST_RUNNERS.has(node.source.value)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportNamespaceSpecifier") {
              runnerNamespaces.add(specifier.local.name);
              continue;
            }
            if (specifier.type !== "ImportSpecifier") continue;
            if (LIFECYCLE_HOOKS.has(importedName(specifier))) {
              context.report({ node: specifier, message: MESSAGES.lifecycleHook });
            }
          }
          return;
        }
        if (RENDER_HELPER.test(node.source.value)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportSpecifier" && importedName(specifier) === "act") {
              actNames.add(specifier.local.name);
            }
          }
          return;
        }
        if (node.source.value === "react-dom/client") {
          context.report({ node: node.source, message: MESSAGES.reactDomClient });
          return;
        }
        if (node.source.value !== "react") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            reactNamespaces.add(specifier.local.name);
            continue;
          }
          if (REACT_ACT_EXPORTS.has(importedName(specifier))) {
            actNames.add(specifier.local.name);
            context.report({ node: specifier, message: MESSAGES.reactAct });
          }
        }
      },
      AssignmentExpression(node) {
        if (namesActEnvironment(node.left)) {
          context.report({ node: node.left, message: MESSAGES.actEnvironment });
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;
        if (isBrowserTest && isRenderCall(callee.value) && !isDisposedRender(node)) {
          context.report({ node, message: MESSAGES.undisposedRender });
          return;
        }
        if (callee.value.type === "MemberExpression") {
          // vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true) leaves the flag on for the whole test.
          const method = getPropertyName(callee.value.property);
          if (isReactNamespaceAct(callee.value)) {
            context.report({ node: node.callee, message: MESSAGES.reactAct });
            return;
          }
          if (isBrowserTest) {
            const hook = namespaceMember(callee.value, runnerNamespaces);
            if (hook !== undefined && LIFECYCLE_HOOKS.has(hook)) {
              context.report({ node: node.callee, message: MESSAGES.lifecycleHook });
              return;
            }
          }
          if (isRealInput(callee.value) && isInsideAct(node)) {
            context.report({ node, message: MESSAGES.actAroundInput });
            return;
          }
          if (
            Option.getOrUndefined(method) === "stubGlobal" &&
            stringValue(node.arguments[0] as ESTree.Node | undefined) === ACT_ENVIRONMENT
          ) {
            context.report({ node, message: MESSAGES.actEnvironment });
          }
          return;
        }
        if (
          isBrowserTest &&
          callee.value.type === "Identifier" &&
          LIFECYCLE_HOOKS.has(callee.value.name)
        ) {
          context.report({ node: node.callee, message: MESSAGES.lifecycleHook });
        }
      },
    };
  },
});
