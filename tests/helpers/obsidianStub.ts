import * as nodeModule from "node:module";

// The "obsidian" package ships only type definitions, so src/ modules cannot be
// required in Node as-is. Import this file before requiring them: every name
// imported from "obsidian" resolves to an empty class, unless a test assigns its
// own implementation to `obsidian` first. Adding a new import to src/ therefore
// does not break the tests.
const stubs: Record<string, unknown> = {};

export const obsidian: Record<string, unknown> = new Proxy(stubs, {
    get(target, name) {
        if (typeof name !== "string" || name === "__esModule") return undefined;
        if (!(name in target)) target[name] = class {};
        return target[name];
    },
});

type Load = (request: string, ...rest: unknown[]) => unknown;
// Patch the Module class itself (not the import namespace, which may be a copy).
const loader = nodeModule.Module as unknown as { _load: Load };
const originalLoad = loader._load;
loader._load = function (this: unknown, request, ...rest) {
    return request === "obsidian" ? obsidian : originalLoad.call(this, request, ...rest);
};
