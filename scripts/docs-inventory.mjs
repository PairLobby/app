import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';

export function parseSource(root, path) {
    return ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
}

function visit(node, callback) {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
}

function variable(source, name) {
    let value;
    visit(source, (node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) value = node.initializer;
    });
    if (!value) throw new Error(`Missing documentation inventory source: ${name}`);
    while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
    return value;
}

function constant(node, names = {}) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node) && Object.hasOwn(names, node.text)) return names[node.text];
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => constant(span.expression, names) + span.literal.text).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return constant(node.left, names) * constant(node.right, names);
    throw new Error(`Review the documentation default for non-constant expression: ${node.getText()}`);
}

export function settingsInventory(root) {
    const defaults = Object.fromEntries(variable(parseSource(root, 'packages/client/src/local-store.ts'), 'DEFAULT_SETTINGS').properties.map((property) => [property.name.text, constant(property.initializer)]));
    const names = {AUTO_CLOSE_USAGE: constant(variable(parseSource(root, 'packages/cli/src/auto-close.ts'), 'AUTO_CLOSE_USAGE'))};
    return variable(parseSource(root, 'packages/cli/src/device-settings.ts'), 'SETTING_KEYS').properties.map((property) => {
        const definition = Object.fromEntries(property.initializer.properties.filter((field) => ['field', 'kind', 'label', 'section', 'help'].includes(field.name.text)).map((field) => [field.name.text, constant(field.initializer, names)]));
        return {key: property.name.text, ...definition, default: defaults[definition.field]};
    });
}

export function defaultSettingText(setting) {
    if (setting.default === null) return 'never';
    if (typeof setting.default === 'boolean') return setting.default ? 'on' : 'off';
    if (setting.kind === 'managed-duration') return setting.default % 3600000 === 0 ? `${setting.default / 3600000}h` : `${setting.default / 60000}m`;
    return String(setting.default);
}

export function commandInventory(root) {
    const main = parseSource(root, 'packages/cli/src/main.ts');
    const shell = new Set();
    visit(main, (node) => {
        if (ts.isBinaryExpression(node) && node.left.getText(main) === 'positionals[0]' && ts.isStringLiteral(node.right)) shell.add(node.right.text);
        if (ts.isSwitchStatement(node) && node.expression.getText(main) === 'command') {
            for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) shell.add(clause.expression.text);
        }
    });
    const completion = parseSource(root, 'packages/cli/src/chat-completion.ts');
    const chat = new Set(variable(completion, 'CHAT_COMMANDS').elements.map((element) => constant(element)));
    for (const path of ['chat', 'chat-commands', 'permissions', 'presets']) {
        const source = parseSource(root, `packages/cli/src/${path}.ts`);
        visit(source, (node) => {
            if (ts.isStringLiteral(node) && node.parent && (ts.isBinaryExpression(node.parent) || ts.isCallExpression(node.parent))) {
                const match = node.text.match(/^\/([a-z-]+)(?:\s|$)/);
                if (match) chat.add(`/${match[1]}`);
            }
        });
    }
    // Accepted compatibility aliases in the room-command recognizers.
    chat.add('/perms');
    chat.add('/presets');
    const flags = variable(main, 'OPTIONS').properties.map((property) => property.name.text);
    return {shell: [...shell].sort(), chat: [...chat].sort(), flags};
}

export function relayVariables(root) {
    const result = new Set();
    for (const path of ['packages/local-server/src/settings.ts', 'packages/server-core/src/settings.ts']) {
        visit(parseSource(root, path), (node) => {
            if (ts.isStringLiteral(node) && /^PAIRLOBBY_[A-Z0-9_]+$/.test(node.text)) result.add(node.text);
        });
    }
    return [...result].sort();
}

export function managedTools(root) {
    const names = new Set();
    for (const path of ['packages/cli/src/codex-receiver.ts', 'packages/cli/src/receiver-tools.ts']) {
        visit(parseSource(root, path), (node) => {
            if (!ts.isPropertyAssignment(node) || node.name.getText() !== 'name' || !ts.isStringLiteral(node.initializer)) return;
            const name = node.initializer.text;
            if (path.includes('codex-receiver') ? name.startsWith('pairlobby_') : /^[a-z_]+$/.test(name)) names.add(name);
        });
    }
    return [...names].sort();
}
