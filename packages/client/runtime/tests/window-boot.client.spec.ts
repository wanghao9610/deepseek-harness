import { describe, expect, it } from 'vitest'
import { consumeWindowBoot, DEFAULT_WINDOW_BOOT, type PageAddress } from '../src/client/window-boot.ts'

/** A page whose address answers replace() the way a browser's does. */
function page(href: string): PageAddress & { shown: string[] } {
  const shown: string[] = []
  const address: PageAddress & { shown: string[] } = {
    href,
    shown,
    replace: (next) => {
      shown.push(next)
      address.href = new URL(next, address.href).href
    },
  }
  return address
}

describe('consumeWindowBoot', () => {
  it('reads the new-session directive and spends it, so a reload is not another new window', () => {
    const window = page('http://127.0.0.1:4173/?new=1')
    expect(consumeWindowBoot(window)).toEqual({ freshSession: true })
    expect(window.shown).toEqual(['/'])
    // Reloading reads the address the first boot left behind.
    expect(consumeWindowBoot(window)).toEqual(DEFAULT_WINDOW_BOOT)
  })

  it('leaves an ordinary address alone', () => {
    const plain = page('http://127.0.0.1:4173/')
    expect(consumeWindowBoot(plain)).toEqual(DEFAULT_WINDOW_BOOT)
    expect(plain.shown).toEqual([])
  })

  it('keeps every other parameter and the hash when it strips its own', () => {
    const mixed = page('http://127.0.0.1:4173/?fixture&new=1&fixturePrompt=reject#top')
    expect(consumeWindowBoot(mixed)).toEqual({ freshSession: true })
    expect(mixed.shown).toEqual(['/?fixture=&fixturePrompt=reject#top'])
  })

  it('has no directives outside a browser', () => {
    expect(consumeWindowBoot(undefined)).toEqual(DEFAULT_WINDOW_BOOT)
  })
})
