import {join} from 'node:path'
import {homedir} from 'node:os'
import {pathToFileURL} from 'node:url'

// Use the real dsh-go validator. Never replace validation with a passing stub.
const kit = process.env.DSH_GO_PLUGIN_KIT || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills', 'dsh-go-plugin', 'kit')
let validator
try {
  validator = await import(pathToFileURL(join(kit, 'lib', 'view-check.js')).href)
} catch (cause) {
  throw new Error('Native tests require the dsh-go-plugin development kit. Set DSH_GO_PLUGIN_KIT to its kit directory, or run npm run test:core.', {cause})
}
export const checkView = validator.checkView
export const {normalize: checkEffects} = await import(pathToFileURL(join(kit, 'lib', 'bridge', 'effects.js')).href)
