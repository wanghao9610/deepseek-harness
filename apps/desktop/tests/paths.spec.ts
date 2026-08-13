/** Runtime entry resolution for the two layouts the shell runs from. */

import { describe, expect, it } from 'vitest'
import { resolveRuntimeEntry } from '../src/paths.ts'

describe('resolveRuntimeEntry', () => {
  it('resolves the deployed closure inside an installed application', () => {
    expect(resolveRuntimeEntry({
      packaged: true,
      resourcesPath: '/Applications/DeepSeek Harness.app/Contents/Resources',
      appPath: '/Applications/DeepSeek Harness.app/Contents/Resources/app',
    })).toBe('/Applications/DeepSeek Harness.app/Contents/Resources/backend/node_modules/@deepseek-ai/dsh/lib/bin.js')
  })

  it('resolves the sibling CLI build in a checkout run', () => {
    expect(resolveRuntimeEntry({
      packaged: false,
      resourcesPath: '/unused',
      appPath: '/repo/apps/desktop',
    })).toBe('/repo/apps/cli/lib/bin.js')
  })
})
