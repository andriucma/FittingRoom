const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

module.exports = function loadTs(file, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, console, structuredClone, Buffer, URL, URLSearchParams, Request, Response, AbortSignal, setTimeout, clearTimeout,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === 'server-only') return {};
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected test dependency: ${id}`);
    }, ...globals,
  }, { filename });
  return exports;
};
