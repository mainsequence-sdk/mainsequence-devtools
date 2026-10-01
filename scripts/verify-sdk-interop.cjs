// Optional compatibility check against explicit SDK source checkouts; no runtime dependency.
// All credentials are synthetic. OS stores are replaced with an in-memory fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const common = require('../dist/shared/machineSession.js');

const pythonProgram = `
import importlib.util, json, sys, types
sdk, backend = sys.argv[1:]
keyring = types.ModuleType('keyring')
keyring.core = types.ModuleType('keyring.core')
keyring.errors = types.ModuleType('keyring.errors')
keyring.errors.KeyringError = type('KeyringError', (Exception,), {})
keyring.errors.PasswordDeleteError = type('PasswordDeleteError', (keyring.errors.KeyringError,), {})
sys.modules['keyring'] = keyring
sys.modules['keyring.core'] = keyring.core
sys.modules['keyring.errors'] = keyring.errors
defaults_spec = importlib.util.spec_from_file_location('mainsequence.defaults', sdk + '/mainsequence/defaults.py')
defaults = importlib.util.module_from_spec(defaults_spec)
sys.modules['mainsequence.defaults'] = defaults
defaults_spec.loader.exec_module(defaults)
spec = importlib.util.spec_from_file_location('sdk_config_fixture', sdk + '/mainsequence/cli/config.py')
cfg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cfg)
records = json.load(sys.stdin)
class FixtureStore:
    def get_password(self, service, account): return records.get(service + '\\n' + account)
    def set_password(self, service, account, value): records[service + '\\n' + account] = value
cfg._secure_keyring_backend = lambda: FixtureStore()
read = cfg._read_secure_tokens(backend)
ok = cfg._write_secure_tokens(username='Python fixture', access='fixture-python-access', refresh='fixture-python-refresh', backend=backend)
assert ok
print(json.dumps(dict(read=read, records=records, account=cfg._keychain_account_for_backend(backend))))
`;
async function main() {
  const [pythonSdk, nodeSdk] = process.argv.slice(2);
  if (!pythonSdk || !nodeSdk) throw new Error('Usage: node scripts/verify-sdk-interop.cjs PYTHON_SDK_ROOT COMMAND_CENTER_SDK_ROOT');
  const module = await import(pathToFileURL(path.join(path.resolve(nodeSdk), 'command-center-sdk', 'cli', 'machine-session.mjs')));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-sdk-interop-'));
  try {
    const store = { name: 'fixture', records: new Map(), read(s, a) { return this.records.get(s + '\n' + a) || null; }, write(s, a, v) { this.records.set(s + '\n' + a, v); }, remove(s, a) { return this.records.delete(s + '\n' + a); } };
    const pythonEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/MAIN.?SEQUENCE|MAIN_SEQUENCE|PYTHONPATH|PYTHONHOME/i.test(key)));
    pythonEnv.HOME = temporary; pythonEnv.APPDATA = temporary; pythonEnv.PYTHONDONTWRITEBYTECODE = '1';
    for (const backend of ['https://api.main-sequence.app', 'https://Example.test:443/backend/path']) {
      common.saveSession(store, backend, { username: 'José', access: 'fixture-common-access', refresh: 'fixture-common-refresh' });
      assert.equal(module.sessionEntry(backend).account, common.sessionAccount(backend));
      assert.equal(module.readSession({ backend, store }).access, 'fixture-common-access');
      const python = spawnSync('python3', ['-c', pythonProgram, path.resolve(pythonSdk), backend], {
        input: JSON.stringify(Object.fromEntries(store.records)), encoding: 'utf8', env: pythonEnv, cwd: temporary, timeout: 10_000
      });
      assert.equal(python.status, 0, 'Python source contract check failed: ' + python.stderr);
      const result = JSON.parse(python.stdout);
      assert.equal(result.read.access, 'fixture-common-access'); assert.equal(result.account, common.sessionAccount(backend));
      store.records = new Map(Object.entries(result.records));
      assert.equal(common.readSession(store, backend).access, 'fixture-python-access');
      assert.equal(module.readSession({ backend, store }).refresh, 'fixture-python-refresh');
      module.saveSession({ backend, store, username: 'Node fixture', access: 'fixture-node-access', refresh: 'fixture-node-refresh' });
      assert.equal(common.readSession(store, backend).access, 'fixture-node-access');
      const pythonAgain = spawnSync('python3', ['-c', pythonProgram, path.resolve(pythonSdk), backend], { input: JSON.stringify(Object.fromEntries(store.records)), encoding: 'utf8', env: pythonEnv, cwd: temporary, timeout: 10_000 });
      assert.equal(pythonAgain.status, 0); assert.equal(JSON.parse(pythonAgain.stdout).read.refresh, 'fixture-node-refresh');
    }
    console.log('SDK source interoperability passed: common → Python/Node, Python → common/Node, Node → common/Python; two backend identities. Synthetic records only.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
